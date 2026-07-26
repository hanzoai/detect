/**
 * Whether a repo publishes a package, and to where.
 *
 * This is the one block of `PlatformConfig` that is FULLY derivable: a package
 * declares its own registry in its own manifest, and always has. Ground truth
 * on 2026-07-25: `publish:` is wired in platform and NO repo in the fleet
 * declares it — every publishing repo is publishing from a workflow file
 * instead, restating what its manifest already says.
 */
import { hasFile, type RepoTree } from "./tree.ts";
import { nodeManifest } from "./stack.ts";
import type { PublishConfig } from "./types.ts";

/** A `[package]` section with a name — a publishable crate, not a workspace root. */
function isPublishableCrate(text: string): boolean {
	if (!/^\s*\[package\]/m.test(text)) return false;
	// `publish = false` is cargo's own opt-out; honour it.
	if (/^\s*publish\s*=\s*false/m.test(text)) return false;
	return /^\s*name\s*=\s*"/m.test(text);
}

/** A pyproject with a distribution name is a PyPI package. */
function isPublishablePyProject(text: string): boolean {
	return /^\s*\[project\]/m.test(text) && /^\s*name\s*=\s*"/m.test(text);
}

/**
 * Derive `publish:`, or undefined when the repo ships no package.
 *
 * npm:   package.json with a name and `private` not true.
 * pypi:  pyproject.toml with a `[project] name`.
 * cargo: Cargo.toml with a `[package] name` and no `publish = false`.
 */
export function detectPublish(tree: RepoTree): PublishConfig | undefined {
	const pj = nodeManifest(tree);
	const npm = pj !== null && typeof pj.name === "string" && pj.name.length > 0 && pj.private !== true;

	const pyText = tree.read("pyproject.toml");
	const pypi = pyText !== null && isPublishablePyProject(pyText);

	const cargoText = tree.read("Cargo.toml");
	const cargo = cargoText !== null && isPublishableCrate(cargoText);

	if (!npm && !pypi && !cargo) return undefined;
	return { npm, pypi, cargo, cargoCrates: [], packageDir: ".", dryRun: false };
}

/** True when the repo root is a workspace (its own package.json is not shippable). */
export function isJsWorkspaceRoot(tree: RepoTree): boolean {
	const pj = nodeManifest(tree);
	if (pj?.workspaces !== undefined) return true;
	return hasFile(tree, "pnpm-workspace.yaml") || hasFile(tree, "pnpm-workspace.yml");
}
