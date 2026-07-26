#!/usr/bin/env node
/**
 * Snapshot the parts of real fleet repos the detector actually reads —
 * Dockerfile paths (with enough head bytes for toolchain detection) and build
 * manifests — into a fixture the tests can run against hermetically.
 *
 *   node bin/snapshot-trees.ts <org>:<path> ... > test/fixtures/trees.json
 */
import { readFileSync } from "node:fs";
import { fsTree } from "../src/fs-tree.ts";
import { findDockerfiles } from "../src/dockerfile.ts";
import { dirOf, joinPath } from "../src/tree.ts";

const MANIFESTS = [
	"go.mod", "Cargo.toml", "package.json", "pyproject.toml", "setup.py",
	"requirements.txt", "foundry.toml", "index.html",
];

/**
 * Keep the DIRECTIVE lines of a Dockerfile, not its first N bytes.
 * `detectStack` reads `FROM` / `RUN`, and a byte window is the wrong knife:
 * `hanzoai/world` opens with 26 lines of comment before its first `FROM`, so a
 * head-slice fixture silently dropped every signal the detector uses.
 */
function directives(text: string): string {
	return text
		.split("\n")
		.filter((l) => /^\s*(FROM|RUN|ARG|COPY|ENTRYPOINT|CMD|WORKDIR)\b/i.test(l))
		.join("\n");
}

const out: Record<string, { org: string; repo: string; files: Record<string, string> }> = {};

for (const spec of process.argv.slice(2)) {
	const sep = spec.indexOf(":");
	const org = spec.slice(0, sep);
	const path = spec.slice(sep + 1);
	const repo = path.slice(path.lastIndexOf("/") + 1);
	const tree = fsTree(path);
	const files: Record<string, string> = {};

	for (const df of findDockerfiles(tree)) {
		try {
			files[df] = directives(readFileSync(`${path}/${df}`, "utf8"));
		} catch {
			files[df] = "";
		}
		// Manifests beside a nested Dockerfile decide its build context.
		const d = dirOf(df);
		if (d === "") continue;
		for (const m of MANIFESTS) {
			const p = joinPath(d, m);
			if (tree.read(p) !== null) files[p] = "";
		}
	}
	for (const m of MANIFESTS) {
		const text = tree.read(m);
		if (text === null) continue;
		// package.json content matters (name / private); the rest only by presence.
		files[m] = m === "package.json" || m === "Cargo.toml" || m === "pyproject.toml"
			? text.slice(0, 400)
			: "";
	}
	// e2e spec names, for the e2e derivation.
	for (const dir of ["e2e", "tests", "test"]) {
		for (const f of tree.list(dir)) {
			if (/\.spec\.(ts|js|mjs)$/.test(f)) files[joinPath(dir, f)] = "";
		}
	}
	out[`${org}/${repo}`] = { org, repo, files };
}

process.stdout.write(`${JSON.stringify(out, null, "\t")}\n`);
