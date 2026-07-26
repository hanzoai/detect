/**
 * `detect` — a repo tree in, the config platform already consumes out.
 *
 * Two passes, orthogonal and separately useful:
 *
 *   detect(tree, ctx)                    offline. Everything the source states.
 *   withCluster(result, index, ctx)      joins in what the fleet actually runs:
 *                                        corrects image names, fills `deploy:`.
 *
 * Neither pass mutates its input; `withCluster` returns a new result. A caller
 * with no cluster access gets a complete, buildable config from pass one alone.
 */
import { selectImages, type DockerfileCandidate } from "./dockerfile.ts";
import { imageRefFor } from "./registry.ts";
import { detectStack } from "./stack.ts";
import { detectPublish } from "./publish.ts";
import { imageAliases, resolveDeploy, type ClusterIndex } from "./deploy.ts";
import { hasFile, type RepoTree } from "./tree.ts";
import type {
	BuildConfig,
	DetectResult,
	E2eConfig,
	MatrixEntry,
	PlatformConfig,
	Provenance,
} from "./types.ts";

export interface RepoContext {
	/** Org login as the forge reports it: `hanzoai`, `hanzo`, `luxfi`, `zooai`. */
	org: string;
	/** Repository name, without the org. */
	repo: string;
	/** Branch whose successful builds deploy. Defaults to `main`. */
	defaultBranch?: string;
}

/**
 * The matrix every derived build gets. `BUILDABLE_ARCHES` in platform is
 * `["amd64"]` — arm64 is paused fleet-wide — so a derived arm64 entry would be
 * skipped by the scheduler anyway. Deriving exactly what can build keeps the
 * config honest instead of aspirational.
 */
const DEFAULT_MATRIX: MatrixEntry[] = [{ os: "linux", arch: "amd64" }];

/**
 * Tag template. Byte-identical to what platform's `images:` normalization
 * produces (`parseImageEntry`), so a repo that deletes its `hanzo.yml` and
 * falls through to detection keeps pushing the same tags — no image churn on
 * migration.
 */
function tagPatternFor(name: string): string {
	return `{{git.sha}}-amd64-${name}`;
}

/** Playwright specs live in `e2e/` by convention across the fleet. */
function detectE2e(tree: RepoTree, repo: string): E2eConfig | undefined {
	for (const dir of ["e2e", "tests", "test"]) {
		const specs = tree
			.list(dir)
			.filter((f) => /\.spec\.(ts|js|mjs)$/.test(f))
			.sort();
		if (specs.length > 0) return { spec: `${dir}/${specs[0]}` };
	}
	void repo;
	return undefined;
}

/**
 * Offline pass. Reads only the repo.
 */
export function detect(tree: RepoTree, ctx: RepoContext): DetectResult {
	const { org, repo } = ctx;
	const provenance: Provenance[] = [];

	// An unreadable or empty root is NOT "a repo with nothing to build" — it is
	// a broken input, and reporting the two the same way hides a moved checkout
	// or a bad ref behind a plausible-looking "no Dockerfile".
	if (tree.list("").length === 0) {
		return {
			config: { builds: [] },
			provenance,
			stack: "unknown",
			deployable: false,
			reason: "empty or unreadable repo tree",
		};
	}

	const { chosen: candidates, deferred } = selectImages(tree, repo);
	const stack = detectStack(
		tree,
		candidates.map((c) => c.path),
	);

	const publish = detectPublish(tree);
	if (publish) {
		const to = [publish.npm && "npm", publish.pypi && "pypi", publish.cargo && "cargo"]
			.filter(Boolean)
			.join("+");
		provenance.push({
			field: "publish",
			because: `package manifest declares a public package (${to})`,
			source: "tree",
		});
	}

	if (candidates.length === 0) {
		return {
			config: { builds: [], publish },
			provenance,
			stack,
			deployable: false,
			deferred,
			reason: hasFile(tree, "package.json")
				? "no Dockerfile — library or workspace, nothing to containerize"
				: "no Dockerfile",
		};
	}

	const builds: BuildConfig[] = candidates.map((c) => {
		provenance.push({
			field: `builds[${c.name}].dockerfile`,
			because: c.because,
			source: "tree",
		});
		provenance.push({
			field: `builds[${c.name}].image`,
			because: `org ${org} → ${imageRefFor(org, c.name)}`,
			source: "policy",
		});
		if (c.context !== ".") {
			provenance.push({
				field: `builds[${c.name}].context`,
				because: `${c.context} carries its own build manifest`,
				source: "tree",
			});
		}
		return {
			name: c.name,
			matrix: DEFAULT_MATRIX.map((m) => ({ ...m })),
			dockerfile: c.path,
			context: c.context,
			image: imageRefFor(org, c.name),
			tagPattern: tagPatternFor(c.name),
			push: true,
		};
	});

	const e2e = detectE2e(tree, repo);
	if (e2e) {
		provenance.push({ field: "e2e.spec", because: `found ${e2e.spec}`, source: "tree" });
	}

	const config: PlatformConfig = { builds, e2e, publish };
	return { config, provenance, stack, deployable: true, deferred };
}

/** A deferred candidate turned into a real build. */
function buildFrom(c: DockerfileCandidate, org: string): BuildConfig {
	return {
		name: c.name,
		matrix: DEFAULT_MATRIX.map((m) => ({ ...m })),
		dockerfile: c.path,
		context: c.context,
		image: imageRefFor(org, c.name),
		tagPattern: tagPatternFor(c.name),
		push: true,
	};
}

/**
 * Cluster pass. Joins the offline result against the operator CRs.
 *
 *  1. Image-name correction. A derived name with no workload, whose
 *     brand-prefixed alias HAS one, is renamed — this is how `hanzoai/app`
 *     resolves to `ghcr.io/hanzoai/hanzo-app` without anyone writing it down.
 *  2. `deploy:` resolution, from the workload pinned to the resulting image.
 */
export function withCluster(
	result: DetectResult,
	index: ClusterIndex,
	ctx: RepoContext,
): DetectResult {
	if (!result.deployable) return result;
	const branches = [ctx.defaultBranch ?? "main"];
	const provenance = [...result.provenance];
	/** Every image the fleet references, from any workload — proof it exists. */
	const known = new Set(index.map((w) => w.imageRepo));
	/**
	 * Images an OPERATOR workload is pinned to. This, not `known`, decides a
	 * rename: `hanzoai/app` has a stale plain Deployment still on
	 * `ghcr.io/hanzoai/app` while the App CR that actually governs the rollout
	 * runs `ghcr.io/hanzoai/hanzo-app`. Trusting `known` here would let the
	 * stale Deployment veto the correct answer.
	 */
	const operatorKnown = new Set(
		index.filter((w) => w.kind === "App" || w.kind === "Service").map((w) => w.imageRepo),
	);

	const builds = result.config.builds.map((b) => {
		if (operatorKnown.has(b.image)) return b;
		for (const alias of imageAliases(b.name, ctx.org).slice(1)) {
			const ref = imageRefFor(ctx.org, alias);
			if (!operatorKnown.has(ref)) continue;
			provenance.push({
				field: `builds[${b.name}].image`,
				because: `no workload runs ${b.image}; the fleet runs ${ref}`,
				source: "cluster",
			});
			return { ...b, name: alias, image: ref, tagPattern: tagPatternFor(alias) };
		}
		return b;
	});

	// Promote deferred candidates the fleet demonstrably runs. This is the whole
	// point of deferring: `commerce`'s admin and site images come back here, its
	// dead `Dockerfile.sqfix` does not, and no blocklist was needed to tell them
	// apart.
	for (const c of result.deferred ?? []) {
		const ref = imageRefFor(ctx.org, c.name);
		if (!known.has(ref)) continue;
		if (builds.some((b) => b.image === ref)) continue;
		builds.push(buildFrom(c, ctx.org));
		provenance.push({
			field: `builds[${c.name}]`,
			because: `deferred by the tree pass; promoted because the fleet runs ${ref}`,
			source: "cluster",
		});
	}

	// Deploy follows the FIRST build that something in the fleet runs. A repo
	// whose images are all build-only (an embed artifact, a base layer) yields
	// no deploy block — which is exactly what those repos declare by hand.
	let deploy = result.config.deploy;
	for (const b of builds) {
		const resolved = resolveDeploy(index, b.image, branches);
		if (!resolved) continue;
		deploy = resolved.deploy;
		provenance.push({
			field: "deploy.target",
			because: `${resolved.deploy.target.crd} ${resolved.deploy.target.namespace}/${resolved.deploy.target.name} runs ${b.image}`,
			source: "cluster",
		});
		if (resolved.alternatives.length > 0) {
			provenance.push({
				field: "deploy.target",
				because: `also runs in ${resolved.alternatives.map((w) => `${w.namespace}/${w.name}`).join(", ")}`,
				source: "cluster",
			});
		}
		break;
	}

	return { ...result, config: { ...result.config, builds, deploy }, provenance };
}
