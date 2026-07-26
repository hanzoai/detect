/**
 * What a repo is built with.
 *
 * Manifests answer this for single-language repos. Polyglot repos (the fleet
 * has real ones — `hanzoai/world` carries both a `go.mod` and a
 * `vite.config.ts`) are decided by the Dockerfile, because the Dockerfile is
 * the only artifact that states which toolchain actually produces the image.
 */
import { hasFile, readJson, type RepoTree } from "./tree.ts";
import type { Stack } from "./types.ts";

/** Root manifests, in the order a tie is broken when no Dockerfile decides it. */
const MANIFESTS: ReadonlyArray<readonly [Stack, string]> = [
	["go", "go.mod"],
	["rust", "Cargo.toml"],
	["node", "package.json"],
	["python", "pyproject.toml"],
	["python", "setup.py"],
	["python", "requirements.txt"],
	["solidity", "foundry.toml"],
];

/**
 * Toolchain fingerprints for ONE Dockerfile line. Applied in file order, so a
 * multi-stage build is decided by its FIRST stage, not by whichever stack
 * happens to sit earliest in this table. `hanzoai/world` is the case that
 * matters: `FROM node` (line 27) builds the SPA and `FROM golang` (line 49)
 * builds the server, and matching table-first rather than file-first silently
 * called the repo Go.
 */
const LINE_SIGNALS: ReadonlyArray<readonly [Stack, RegExp]> = [
	["go", /^\s*FROM\s+\S*golang[:\s]/i],
	["rust", /^\s*FROM\s+\S*rust[:\s]/i],
	["node", /^\s*FROM\s+\S*(node|bun|oven\/bun)[:\s]/i],
	["python", /^\s*FROM\s+\S*(python|astral-sh\/uv)[:\s]/i],
	["go", /^\s*RUN\s+.*\bgo build\b/i],
	["rust", /^\s*RUN\s+.*\bcargo build\b/i],
	["node", /^\s*RUN\s+.*\b(npm|pnpm|yarn|bun)\s+(ci|install|run)\b/i],
	["python", /^\s*RUN\s+.*\b(pip|uv)\s+install\b/i],
];

/** First toolchain named by a Dockerfile, reading top to bottom. */
export function dockerfileStack(text: string, allowed: Stack[]): Stack | null {
	for (const line of text.split("\n")) {
		for (const [stack, re] of LINE_SIGNALS) {
			if (re.test(line) && allowed.includes(stack)) return stack;
		}
	}
	return null;
}

/** Every stack the repo carries a root manifest for. */
export function stacksPresent(tree: RepoTree): Stack[] {
	const out: Stack[] = [];
	for (const [stack, file] of MANIFESTS) {
		if (hasFile(tree, file) && !out.includes(stack)) out.push(stack);
	}
	if (out.length === 0 && hasFile(tree, "hardhat.config.js")) out.push("solidity");
	return out;
}

/**
 * The repo's primary stack. When several manifests are present, the first
 * Dockerfile that names a toolchain decides; absent that, manifest order wins.
 */
export function detectStack(tree: RepoTree, dockerfilePaths: string[] = []): Stack {
	const present = stacksPresent(tree);
	if (present.length === 0) return hasFile(tree, "index.html") ? "static" : "unknown";
	if (present.length === 1) return present[0] as Stack;

	for (const path of dockerfilePaths) {
		const text = tree.read(path);
		if (text === null) continue;
		const found = dockerfileStack(text, present);
		if (found) return found;
	}
	return present[0] as Stack;
}

/** package.json, when the repo has one. */
export interface NodeManifest {
	name?: string;
	version?: string;
	private?: boolean;
	workspaces?: unknown;
	scripts?: Record<string, string>;
	publishConfig?: { access?: string };
}

export function nodeManifest(tree: RepoTree, dir = "."): NodeManifest | null {
	return readJson<NodeManifest>(tree, dir === "." ? "package.json" : `${dir}/package.json`);
}
