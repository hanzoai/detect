#!/usr/bin/env node
/**
 * Audit: run detection over real repos and report, per repo, what the declared
 * `hanzo.yml` states that detection could NOT produce.
 *
 * This is the measurement that decides whether a config file is pulling its
 * weight. It is a report, not a test — `test/fleet.test.ts` holds the
 * assertions.
 *
 *   node bin/audit.ts <index.json> <org>:<path> [<org>:<path> ...]
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { fsTree } from "../src/fs-tree.ts";
import { detect, withCluster } from "../src/detect.ts";
import { irreducible } from "../src/merge.ts";
import type { ClusterIndex } from "../src/deploy.ts";
import type { BuildConfig, PlatformConfig } from "../src/types.ts";

/**
 * Read a declared `hanzo.yml` into the same normalized shape the detector
 * emits. Mirrors platform's `validatePlatformConfig` for the fields that
 * matter to a derivability comparison — it is deliberately lenient, because
 * the point is to compare VALUES, not to re-validate.
 */
function readDeclared(path: string, org: string): PlatformConfig | null {
	let raw: Record<string, unknown>;
	try {
		raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const builds: BuildConfig[] = [];
	const mk = (
		name: string,
		image: string,
		dockerfile: string,
		context: string,
	): BuildConfig => ({
		name,
		matrix: [{ os: "linux", arch: "amd64" }],
		dockerfile: dockerfile.replace(/^\.\//, ""),
		context: context.replace(/^\.\//, "") || ".",
		image,
		tagPattern: `{{git.sha}}-amd64-${name}`,
		push: true,
	});

	if (Array.isArray(raw.images)) {
		for (const e of raw.images as Array<Record<string, string | undefined>>) {
			const ctx = e.context ?? ".";
			builds.push(
				mk(e.name ?? "", e.repo ?? "", e.dockerfile ?? `${ctx}/Dockerfile`, ctx),
			);
		}
	} else if (raw.build && typeof raw.build === "object") {
		const b = raw.build as Record<string, string>;
		const image = b.image ?? "";
		const name = image.slice(image.lastIndexOf("/") + 1);
		builds.push(mk(name, image, b.dockerfile ?? "./Dockerfile", b.context ?? "."));
	}
	void org;
	const d = raw.deploy as Record<string, unknown> | undefined;
	return {
		builds,
		deploy: d
			? {
					on: (d.on as string[]) ?? ["main"],
					target: {
						cluster: String((d.cluster as string) ?? (d.target as Record<string, string>)?.cluster ?? ""),
						namespace: String((d.namespace as string) ?? (d.target as Record<string, string>)?.namespace ?? ""),
						operator: "hanzo-operator",
						crd: String((d.target as Record<string, string>)?.crd ?? "App"),
						name: String((d.target as Record<string, string>)?.name ?? ""),
					},
				}
			: undefined,
		e2e: raw.e2e as PlatformConfig["e2e"],
		publish: raw.publish as PlatformConfig["publish"],
	};
}

const [indexPath, ...specs] = process.argv.slice(2);
if (!indexPath) {
	process.stderr.write("usage: audit.ts <cluster-index.json> <org>:<path>...\n");
	process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, "utf8")) as ClusterIndex;

let totalDeclaredFields = 0;
let totalIrreducible = 0;

for (const spec of specs) {
	const sep = spec.indexOf(":");
	const org = spec.slice(0, sep);
	const path = spec.slice(sep + 1);
	const repo = path.slice(path.lastIndexOf("/") + 1);
	const ctx = { org, repo };

	const derived = withCluster(detect(fsTree(path), ctx), index, ctx);
	const declared = readDeclared(`${path}/hanzo.yml`, org);

	console.log(`\n=== ${org}/${repo} ===`);
	console.log(`  stack       ${derived.stack}`);
	for (const b of derived.config.builds) {
		console.log(`  DERIVED     ${b.name.padEnd(20)} ${b.image}  <- ${b.dockerfile} (ctx ${b.context})`);
	}
	if (derived.config.deploy) {
		const t = derived.config.deploy.target;
		console.log(`  DERIVED     deploy -> ${t.crd} ${t.cluster} ${t.namespace}/${t.name}`);
	}
	if (!declared) {
		console.log("  (no hanzo.yml)");
		continue;
	}
	for (const b of declared.builds) {
		console.log(`  DECLARED    ${b.name.padEnd(20)} ${b.image}  <- ${b.dockerfile} (ctx ${b.context})`);
	}
	if (declared.deploy) {
		const t = declared.deploy.target;
		console.log(`  DECLARED    deploy -> ${t.cluster} ${t.namespace}/${t.name || "(services:)"}`);
	}
	const gaps = irreducible(derived.config, declared);
	// Declared "fields" counted the way a human writes them: one per image, plus
	// one for each of deploy / e2e / publish.
	const declaredFields =
		declared.builds.length +
		(declared.deploy ? 1 : 0) +
		(declared.e2e ? 1 : 0) +
		(declared.publish ? 1 : 0);
	totalDeclaredFields += declaredFields;
	totalIrreducible += gaps.length;
	if (gaps.length === 0) console.log("  ✅ FULLY DERIVABLE — this file states nothing new");
	else for (const g of gaps) console.log(`  ⚠️  ${g}`);
}

console.log(`\n--- totals: ${totalDeclaredFields} declared units, ${totalIrreducible} irreducible ---`);
