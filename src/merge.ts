/**
 * The override contract.
 *
 * Derived config is the DEFAULT. A repo commits a `hanzo.yml` only to say
 * something the tree and the cluster cannot, and that file should be tiny.
 *
 * One rule, applied at two levels:
 *
 *   SET   — if the file declares images at all (`images:` or `build:`), that
 *           list IS the set of images to build. Declaring nothing means "build
 *           what you derived". This is the only way to REMOVE a derived image,
 *           and it needs no new key: `hanzoai/cloud` already uses exactly this
 *           shape by hand to keep its main image out of the platform pipeline.
 *
 *   FIELD — inside a build the repo did declare, and for `deploy:` / `e2e:` /
 *           `publish:`, the declared value wins outright.
 *
 * Consequence worth stating plainly: because platform's parser fills its own
 * defaults (`context: "."`, `tagPattern`) before this sees the value, a
 * declared build cannot distinguish "omitted" from "explicitly the default".
 * Derived values therefore fill only fields of builds the repo did NOT declare.
 * That is why the recommended first wiring is fallback-only (§README) — it
 * changes nothing for the repos that already have a file.
 */
import type { PlatformConfig } from "./types.ts";

/**
 * `derived` ⊕ `declared`. Returns a new config; neither input is mutated.
 * Passing `undefined` for `declared` yields the derived config unchanged,
 * which is the zero-config path.
 */
export function mergeConfig(
	derived: PlatformConfig,
	declared?: PlatformConfig,
): PlatformConfig {
	if (!declared) return derived;

	const builds = declared.builds.length > 0 ? declared.builds : derived.builds;

	return {
		builds,
		deploy: declared.deploy ?? derived.deploy,
		e2e: declared.e2e ?? derived.e2e,
		publish: declared.publish ?? derived.publish,
	};
}

/**
 * The fields a repo's `hanzo.yml` states that detection could NOT have
 * produced. This is the file's whole reason to exist — running it over the
 * fleet is how you measure whether the config is pulling its weight.
 */
export function irreducible(
	derived: PlatformConfig,
	declared: PlatformConfig,
): string[] {
	const out: string[] = [];
	const byName = new Map(derived.builds.map((b) => [b.name, b]));

	for (const d of declared.builds) {
		const g = byName.get(d.name);
		if (!g) {
			out.push(`builds[${d.name}] — not derived at all`);
			continue;
		}
		if (g.dockerfile !== d.dockerfile) {
			out.push(`builds[${d.name}].dockerfile — derived ${g.dockerfile}, declared ${d.dockerfile}`);
		}
		if (g.context !== d.context) {
			out.push(`builds[${d.name}].context — derived ${g.context}, declared ${d.context}`);
		}
		if (g.image !== d.image) {
			out.push(`builds[${d.name}].image — derived ${g.image}, declared ${d.image}`);
		}
	}
	for (const g of derived.builds) {
		if (!declared.builds.some((d) => d.name === g.name)) {
			out.push(`builds[${g.name}] — derived but deliberately not declared`);
		}
	}
	if (declared.deploy && !derived.deploy) out.push("deploy — declared, no workload found");
	if (declared.e2e && !derived.e2e) out.push("e2e — declared, not derivable");
	if (declared.publish && !derived.publish) out.push("publish — declared, not derivable");
	return out;
}
