/**
 * Org → container-registry namespace. The registries never mix, so this table
 * is the single place that knows the mapping and the only reason an image ref
 * is ever constructed by hand.
 *
 * Forge org logins and GHCR namespaces are NOT the same string: Hanzo Git
 * serves the `hanzo` org while its images live under `ghcr.io/hanzoai`. Both
 * spellings map to one namespace so a webhook from either surface resolves
 * identically.
 */
const ORG_TO_NAMESPACE: Readonly<Record<string, string>> = {
	hanzo: "hanzoai",
	hanzoai: "hanzoai",
	lux: "luxfi",
	luxfi: "luxfi",
	zoo: "zooai",
	zooai: "zooai",
};

export const REGISTRY_HOST = "ghcr.io";

/**
 * GHCR namespace for an org login. An unknown org maps to itself — the
 * forward-safe default for a new org that names its namespace after its login,
 * and never a silent cross-org write.
 */
export function namespaceFor(org: string): string {
	return ORG_TO_NAMESPACE[org.toLowerCase()] ?? org.toLowerCase();
}

/** Full image reference (no tag) for an org + image name. */
export function imageRefFor(org: string, name: string): string {
	return `${REGISTRY_HOST}/${namespaceFor(org)}/${name}`;
}
