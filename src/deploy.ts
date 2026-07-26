/**
 * Deploy target, derived from what the fleet actually runs.
 *
 * A repo cannot know which cluster and namespace its image is rolled into —
 * that is not a property of the source. But it is not unknowable either: the
 * operator CRs already say it. So `deploy:` is not "irreducible config", it is
 * a JOIN — image ref → the workload already running that image. Values over
 * places: the cluster is the value, `hanzo.yml` was a stale copy of it.
 *
 * This module is pure. The caller supplies the index (see `bin/cluster-index.ts`
 * for the read-only kubectl reader that builds one).
 */
import type { DeployConfig, DeployTarget } from "./types.ts";

/** One operator workload and the image repo it is pinned to. */
export interface WorkloadRef {
	cluster: string;
	namespace: string;
	/** Operator CRD kind, `App` or `Service`. */
	kind: string;
	name: string;
	/** Image repository with no tag, e.g. `ghcr.io/hanzoai/world`. */
	imageRepo: string;
}

export type ClusterIndex = readonly WorkloadRef[];

/** Org login → brand prefix used in fleet image names (`hanzo-app`). */
const ORG_TO_BRAND: Readonly<Record<string, string>> = {
	hanzoai: "hanzo",
	hanzo: "hanzo",
	luxfi: "lux",
	lux: "lux",
	zooai: "zoo",
	zoo: "zoo",
};

/**
 * Namespaces that hold an org's PRODUCTION workloads, preferred over
 * `*-testnet` / `*-devnet` / tenant namespaces when one image runs in several.
 */
const PROD_NAMESPACES = new Set(["hanzo", "lux", "lux-ns", "zoo"]);

/** The image names a repo's image could plausibly be published under. */
export function imageAliases(name: string, org: string): string[] {
	const brand = ORG_TO_BRAND[org.toLowerCase()];
	const out = [name];
	if (brand && !name.startsWith(`${brand}-`)) out.push(`${brand}-${name}`);
	return out;
}

/**
 * Kinds the platform can roll an image onto. The index may also carry plain
 * `Deployment`s — they are excellent evidence that an image EXISTS (used for
 * image-name correction) but the operator does not own them, so they can never
 * become a deploy target.
 */
const OPERATOR_KINDS = new Set(["App", "Service"]);

/** All workloads pinned to an exact image repository. */
export function workloadsForImage(index: ClusterIndex, imageRepo: string): WorkloadRef[] {
	return index.filter((w) => w.imageRepo === imageRepo);
}

/**
 * Rank workloads so the canonical production one sorts first: production
 * namespace beats every other, then a CR whose name equals the image's last
 * segment, then lexical order so the result is stable.
 */
export function rankWorkloads(refs: WorkloadRef[]): WorkloadRef[] {
	const imageLeaf = (w: WorkloadRef) => w.imageRepo.slice(w.imageRepo.lastIndexOf("/") + 1);
	return [...refs].sort((a, b) => {
		const ap = PROD_NAMESPACES.has(a.namespace) ? 0 : 1;
		const bp = PROD_NAMESPACES.has(b.namespace) ? 0 : 1;
		if (ap !== bp) return ap - bp;
		const an = a.name === imageLeaf(a) ? 0 : 1;
		const bn = b.name === imageLeaf(b) ? 0 : 1;
		if (an !== bn) return an - bn;
		return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
	});
}

/**
 * Resolve the deploy target for an image repo, or null when nothing in the
 * fleet runs it (a build-only repo — which is a real and common answer).
 */
export function resolveDeploy(
	index: ClusterIndex,
	imageRepo: string,
	branches: string[] = ["main"],
): { deploy: DeployConfig; alternatives: WorkloadRef[] } | null {
	const refs = rankWorkloads(
		workloadsForImage(index, imageRepo).filter((w) => OPERATOR_KINDS.has(w.kind)),
	);
	const chosen = refs[0];
	if (!chosen) return null;
	const target: DeployTarget = {
		cluster: chosen.cluster,
		namespace: chosen.namespace,
		operator: "hanzo-operator",
		crd: chosen.kind,
		name: chosen.name,
	};
	return { deploy: { on: [...branches], target }, alternatives: refs.slice(1) };
}
