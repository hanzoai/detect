/**
 * Filesystem adapter for `RepoTree`. The one impure file in this package —
 * isolated here so every rule module stays testable without touching a disk.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoTree } from "./tree.ts";

/**
 * A `RepoTree` rooted at `root`, with per-call caching so a detect run walks
 * each directory once. Symlinks are followed for reads but never for listing,
 * so a self-referential link cannot loop the walk.
 */
export function fsTree(root: string): RepoTree {
	const listCache = new Map<string, string[]>();
	const readCache = new Map<string, string | null>();
	return {
		list(dir: string): string[] {
			const cached = listCache.get(dir);
			if (cached) return cached;
			let out: string[];
			try {
				out = readdirSync(join(root, dir)).sort();
			} catch {
				out = [];
			}
			listCache.set(dir, out);
			return out;
		},
		read(path: string): string | null {
			if (readCache.has(path)) return readCache.get(path) ?? null;
			let out: string | null;
			try {
				const p = join(root, path);
				out = statSync(p).isFile() ? readFileSync(p, "utf8") : null;
			} catch {
				out = null;
			}
			readCache.set(path, out);
			return out;
		},
	};
}
