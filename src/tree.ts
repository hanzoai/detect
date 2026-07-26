/**
 * `RepoTree` — the only thing the detector knows about a repo.
 *
 * Two reads, no writes, no network types leaking in. Keeping the detector
 * behind this interface is what makes it a pure function: the same tree always
 * yields the same config, so every rule is unit-testable from an in-memory
 * fixture and the Hanzo Git adapter needs no test double.
 */
export interface RepoTree {
	/** Entry names directly under `dir` ("" = repo root). Missing dir → []. */
	list(dir: string): string[];
	/** UTF-8 contents of `path`, or null when absent / not a regular file. */
	read(path: string): string | null;
}

/** Join tree path segments. "" is the root, so it never contributes a "/". */
export function joinPath(...parts: string[]): string {
	return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** Directory portion of a tree path; "" for a root-level file. */
export function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/** Final segment of a tree path. */
export function baseOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

/** True when `path` exists as a readable file. */
export function hasFile(tree: RepoTree, path: string): boolean {
	return tree.read(path) !== null;
}

/** Parse a JSON file from the tree; null on absent or malformed. */
export function readJson<T = Record<string, unknown>>(
	tree: RepoTree,
	path: string,
): T | null {
	const text = tree.read(path);
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/**
 * In-memory tree from a flat `{ "path/to/file": contents }` map. Directories
 * are implied by the paths — the fixture never has to declare them, which is
 * what keeps the test files readable.
 */
export function memTree(files: Record<string, string>): RepoTree {
	const norm = (p: string) => p.replace(/^\.\//, "").replace(/^\/+/, "");
	const map = new Map<string, string>();
	for (const [k, v] of Object.entries(files)) map.set(norm(k), v);
	return {
		list(dir: string): string[] {
			const prefix = dir === "" ? "" : `${norm(dir)}/`;
			const out = new Set<string>();
			for (const p of map.keys()) {
				if (!p.startsWith(prefix)) continue;
				const rest = p.slice(prefix.length);
				if (rest === "") continue;
				const seg = rest.split("/")[0];
				if (seg) out.add(seg);
			}
			return [...out].sort();
		},
		read(path: string): string | null {
			return map.get(norm(path)) ?? null;
		},
	};
}
