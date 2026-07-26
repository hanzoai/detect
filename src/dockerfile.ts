/**
 * Which Dockerfiles in a repo are production images, and what each image is
 * called.
 *
 * Every rule here was read off the fleet's 16 distinct hand-written configs,
 * not invented. Where the tree genuinely under-determines the answer the rule
 * yields the conservative choice and records why, so the cluster pass
 * (`src/deploy.ts`) can correct it from what the fleet actually runs.
 */
import { baseOf, dirOf, hasFile, joinPath, type RepoTree } from "./tree.ts";

/** Directories that never contain repo source, so the walk skips them whole. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"vendor",
	"target",
	"dist",
	"build",
	"out",
	".next",
	"testdata",
	"fixtures",
	"third_party",
	"examples",
	"example",
	".venv",
	"venv",
	"__pycache__",
	".turbo",
	"coverage",
]);

/**
 * Suffixes that mark a NON-production variant. Deliberately short: it lists
 * only words whose meaning is unambiguous across every ecosystem. Anything
 * else is decided structurally (does an unsuffixed Dockerfile also exist?),
 * which is what keeps this from rotting into a per-repo blocklist.
 */
const DEV_SUFFIXES = new Set([
	"dev",
	"local",
	"test",
	"tests",
	"debug",
	"ci",
	"example",
	"sample",
]);

/** Suffixes that mean "this IS the production image for the repo". */
const RELEASE_SUFFIXES = new Set(["production", "prod", "release"]);

/** Directories that exist only to hold build files; they never name an image. */
const BUILD_DIRS = new Set(["docker", "build", "deploy", ".docker", "ci", "infra"]);

/** Manifests that make a directory a self-contained build context. */
const CONTEXT_MANIFESTS = ["Cargo.toml", "go.mod", "package.json", "pyproject.toml"];

/**
 * Most images a repo with NO root Dockerfile may have inferred for it. Above
 * this the repo is a multi-component monorepo whose image set is a product
 * decision, not a fact about the tree.
 */
const MAX_INFERRED_COMPONENTS = 4;

export interface DockerfileCandidate {
	/** Repo-relative path, e.g. `native/flags/Dockerfile`. */
	path: string;
	/** Derived image name, e.g. `cloud-flags`. */
	name: string;
	/** Derived build context, e.g. `native/flags` or `.`. */
	context: string;
	/** Why this file was selected — carried into provenance. */
	because: string;
}

/** Every Dockerfile in the tree, bounded to `maxDepth` directories deep. */
export function findDockerfiles(tree: RepoTree, maxDepth = 4): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		for (const entry of tree.list(dir)) {
			const path = joinPath(dir, entry);
			if (/^Dockerfile(\.[A-Za-z0-9._-]+)?$/.test(entry)) {
				out.push(path);
				continue;
			}
			// A name with a dot that isn't a Dockerfile is a file; don't descend.
			if (depth >= maxDepth || SKIP_DIRS.has(entry) || entry.startsWith(".")) {
				continue;
			}
			// Descend only into things that list as directories (a file lists []).
			if (tree.list(path).length > 0) walk(path, depth + 1);
		}
	};
	walk("", 0);
	return out.sort();
}

/** The `.<suffix>` of a Dockerfile name, or null when unsuffixed. */
export function suffixOf(path: string): string | null {
	const base = baseOf(path);
	return base.startsWith("Dockerfile.") ? base.slice("Dockerfile.".length) : null;
}

/**
 * Image name for a Dockerfile path.
 *
 * Verified against the fleet:
 *   `Dockerfile`                 + repo iam       → `iam`
 *   `Dockerfile.production`      + repo app       → `app`        (release suffix)
 *   `Dockerfile.api`             + repo exchange  → `exchange-api`
 *   `Dockerfile.embed`           + repo console   → `console-embed`
 *   `Dockerfile.commerce-admin`  + repo commerce  → `commerce-admin` (already prefixed)
 *   `docker/Dockerfile`          + repo node      → `node`       (build dir)
 *   `native/flags/Dockerfile`    + repo cloud     → `cloud-flags`
 *   `cmd/hanzod/Dockerfile`      + repo node      → `hanzod`     (Go cmd = binary name)
 */
export function imageNameFor(path: string, repo: string): string {
	const suffix = suffixOf(path);
	const dir = dirOf(path);

	if (suffix !== null) {
		if (RELEASE_SUFFIXES.has(suffix)) return repo;
		return suffix.startsWith(repo) ? suffix : `${repo}-${suffix}`;
	}
	if (dir === "" || BUILD_DIRS.has(dir)) return repo;

	const seg = baseOf(dir);
	// `cmd/<x>` is Go's binary convention: <x> already names the artifact.
	if (dirOf(dir) === "cmd") return seg;
	return seg.startsWith(repo) ? seg : `${repo}-${seg}`;
}

/**
 * Build context for a Dockerfile. `.` unless the Dockerfile's own directory
 * carries a build manifest — that makes it a self-contained component whose
 * context is itself (how `native/flags` is built), rather than a Dockerfile
 * that merely lives in a subdirectory of the repo it builds.
 */
export function contextFor(tree: RepoTree, path: string): string {
	const dir = dirOf(path);
	if (dir === "" || BUILD_DIRS.has(dir)) return ".";
	const selfContained = CONTEXT_MANIFESTS.some((m) => hasFile(tree, joinPath(dir, m)));
	return selfContained ? dir : ".";
}

/** What `selectImages` decided, and what it deliberately held back. */
export interface ImageSelection {
	/** Build these. */
	chosen: DockerfileCandidate[];
	/**
	 * Plausible images the tree alone cannot confirm. Held back rather than
	 * discarded so the cluster pass can promote the ones the fleet runs.
	 * `commerce-admin` and `commerce-site` are recovered exactly this way.
	 */
	deferred: DockerfileCandidate[];
}

/**
 * Production image candidates, in a stable order.
 *
 * The selection is structural, in one pass:
 *  - drop unambiguous dev variants (`Dockerfile.dev`, …) outright;
 *  - only a PRIMARY Dockerfile — at the repo root, or in a pure build directory
 *    like `docker/` — can be chosen outright. A Dockerfile nested in a
 *    component directory (`native/flags`, `app/admin`, `metering/proxy`) is
 *    deferred: a component is only a product if the fleet ships it;
 *  - a release-suffixed file (`Dockerfile.production`) SUPERSEDES the plain
 *    root `Dockerfile` for the repo-named image — this is what `app` and
 *    `commerce` both do by hand, and building both would push two different
 *    images to one name;
 *  - a non-release-suffixed primary Dockerfile is chosen only when the repo has
 *    no unsuffixed primary anywhere; otherwise it is DEFERRED;
 *  - if that leaves nothing at all, every surviving candidate is chosen — a
 *    repo with Dockerfiles must build something (this is what carries
 *    `otel-collector`, whose only images live under `cmd/`).
 *
 * The deferral is the honest part. `commerce`'s `Dockerfile.store` and `iam`'s
 * `Dockerfile.v2` are indistinguishable from the tree — one is a live image,
 * the other is dead. Guessing either way is wrong, so the tree pass declines to
 * guess and the cluster pass decides on evidence.
 */
export function selectImages(tree: RepoTree, repo: string): ImageSelection {
	const all = findDockerfiles(tree);
	const kept = all.filter((p) => {
		const s = suffixOf(p);
		return s === null || !DEV_SUFFIXES.has(s.toLowerCase());
	});

	/** At the repo root or in a pure build directory — not a nested component. */
	const isPrimary = (p: string): boolean => {
		const d = dirOf(p);
		return d === "" || BUILD_DIRS.has(d);
	};

	const hasUnsuffixedPrimary = kept.some((p) => suffixOf(p) === null && isPrimary(p));

	const chosenPaths: string[] = [];
	const deferredPaths: string[] = [];
	for (const p of kept) {
		const s = suffixOf(p);
		const primary = isPrimary(p);
		if (primary && (s === null || RELEASE_SUFFIXES.has(s) || !hasUnsuffixedPrimary)) {
			chosenPaths.push(p);
		} else {
			deferredPaths.push(p);
		}
	}

	// A repo whose components are all nested chose nothing above. Fall back to
	// the survivors — preferring unsuffixed files, so `otel-collector` falls
	// back to its two `cmd/*/Dockerfile`s and not to their `.multi-arch` /
	// `.selfbuild` variants as well.
	//
	// BOUNDED, because this is the one rule that guesses. `hanzoai/pipelines`
	// (a Kubeflow fork) has 20+ component Dockerfiles and no root image;
	// unbounded, this would schedule fifteen builds nobody asked for on a repo
	// the fleet does not deploy. Past the cap the honest answer is "I cannot
	// tell" — the repo declares its images, and detection stays out of the way.
	if (chosenPaths.length === 0) {
		const plain = deferredPaths.filter((p) => suffixOf(p) === null);
		const fallback = plain.length > 0 ? plain : [...deferredPaths];
		if (fallback.length <= MAX_INFERRED_COMPONENTS) {
			chosenPaths.push(...fallback);
			for (const p of fallback) deferredPaths.splice(deferredPaths.indexOf(p), 1);
		}
	}

	// A release-suffixed file supersedes a plain Dockerfile with the same name.
	const released = new Set(
		chosenPaths
			.filter((p) => RELEASE_SUFFIXES.has(suffixOf(p) ?? ""))
			.map((p) => imageNameFor(p, repo)),
	);
	const final = chosenPaths.filter(
		(p) => suffixOf(p) !== null || !released.has(imageNameFor(p, repo)),
	);

	const toCandidate = (path: string): DockerfileCandidate => {
		const s = suffixOf(path);
		const because =
			s !== null && RELEASE_SUFFIXES.has(s)
				? `${path} (release variant supersedes plain Dockerfile)`
				: dirOf(path) === ""
					? `root ${path}`
					: path;
		return { path, name: imageNameFor(path, repo), context: contextFor(tree, path), because };
	};

	/**
	 * Two Dockerfiles can derive the same image name — `commerce` has both
	 * `Dockerfile.admin` and `Dockerfile.commerce-admin`, and both mean
	 * `commerce-admin`. Prefer the one that spells the image out in full: a
	 * fully-qualified suffix states its intent, a bare one is relative and is
	 * more often the older of the two.
	 */
	const bySpecificity = (a: string, b: string): number => {
		const qa = (suffixOf(a) ?? "").startsWith(repo) ? 0 : 1;
		const qb = (suffixOf(b) ?? "").startsWith(repo) ? 0 : 1;
		return qa !== qb ? qa - qb : a.localeCompare(b);
	};
	final.sort(bySpecificity);
	deferredPaths.sort(bySpecificity);

	// De-duplicate by image name; first path wins (sorted → deterministic).
	const seen = new Set<string>();
	const chosen: DockerfileCandidate[] = [];
	for (const path of final) {
		const c = toCandidate(path);
		if (seen.has(c.name)) continue;
		seen.add(c.name);
		chosen.push(c);
	}
	const deferred: DockerfileCandidate[] = [];
	for (const path of deferredPaths) {
		const c = toCandidate(path);
		if (seen.has(c.name)) continue;
		seen.add(c.name);
		deferred.push(c);
	}
	return { chosen, deferred };
}
