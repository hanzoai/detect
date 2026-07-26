#!/usr/bin/env node
/**
 * Fleet sweep: run detection over every repo under the given org roots and
 * count how many would need a config file at all.
 *
 *   node bin/sweep.ts <index.json> hanzoai:/Users/z/work/hanzo luxfi:/Users/z/work/lux ...
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fsTree } from "../src/fs-tree.ts";
import { detect, withCluster } from "../src/detect.ts";
import type { ClusterIndex } from "../src/deploy.ts";

const [indexPath, ...roots] = process.argv.slice(2);
if (!indexPath) {
	process.stderr.write("usage: sweep.ts <cluster-index.json> <org>:<root>...\n");
	process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, "utf8")) as ClusterIndex;

function workflowCount(dir: string): number {
	try {
		return readdirSync(join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).length;
	} catch {
		return 0;
	}
}

interface Row {
	org: string;
	repo: string;
	builds: number;
	deploy: boolean;
	publish: boolean;
	deployable: boolean;
	workflows: number;
	hasConfig: boolean;
}

const rows: Row[] = [];
for (const spec of roots) {
	const sep = spec.indexOf(":");
	const org = spec.slice(0, sep);
	const root = spec.slice(sep + 1);
	for (const name of readdirSync(root).sort()) {
		const dir = join(root, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		if (name.startsWith(".") || name === "node_modules") continue;
		const ctx = { org, repo: name };
		const r = withCluster(detect(fsTree(dir), ctx), index, ctx);
		rows.push({
			org,
			repo: name,
			builds: r.config.builds.length,
			deploy: r.config.deploy !== undefined,
			publish: r.config.publish !== undefined,
			deployable: r.deployable,
			workflows: workflowCount(dir),
			hasConfig: existsSync(join(dir, "hanzo.yml")) || existsSync(join(dir, ".platform.yml")),
		});
	}
}

const n = (p: (r: Row) => boolean) => rows.filter(p).length;
const sum = (p: (r: Row) => boolean, f: (r: Row) => number) =>
	rows.filter(p).reduce((a, r) => a + f(r), 0);

console.log(`repos scanned              ${rows.length}`);
console.log(`workflow files today       ${sum(() => true, (r) => r.workflows)}`);
console.log("");
console.log(`NOT deployable (no image)  ${n((r) => !r.deployable)}   workflows: ${sum((r) => !r.deployable, (r) => r.workflows)}`);
console.log(`  …of which publish a pkg  ${n((r) => !r.deployable && r.publish)}`);
console.log(`DEPLOYABLE (≥1 image)      ${n((r) => r.deployable)}   workflows: ${sum((r) => r.deployable, (r) => r.workflows)}`);
console.log(`  …with a derived deploy   ${n((r) => r.deployable && r.deploy)}`);
console.log(`  …build-only (no workload)${n((r) => r.deployable && !r.deploy)}`);
console.log("");
console.log(`repos with a config today  ${n((r) => r.hasConfig)}`);
console.log(`repos needing ZERO config  ${n((r) => true)} - overrides`);
console.log("");
console.log("--- repos with the most workflows that derive cleanly ---");
for (const r of rows
	.filter((x) => x.deployable && !x.hasConfig)
	.sort((a, b) => b.workflows - a.workflows)
	.slice(0, 15)) {
	console.log(
		`  ${String(r.workflows).padStart(3)} wf  ${r.org}/${r.repo.padEnd(28)} ${r.builds} image(s)${r.deploy ? " + deploy" : ""}`,
	);
}
