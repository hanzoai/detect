/**
 * The config shape platform consumes.
 *
 * This is a STRUCTURAL MIRROR of `@hanzo/platform`'s
 * `services/ci/platform-config.ts` `PlatformConfig`. It is duplicated here on
 * purpose: the detector is a pure function over a repo tree and must not drag
 * platform's DB / K8s / tRPC dependency graph in behind it. `test/conformance.test.ts`
 * type-checks this mirror against platform's real declaration, so a drift in
 * either direction fails a test rather than failing in production.
 */

export type BuildOS = "linux" | "darwin" | "windows";
export type BuildArch = "amd64" | "arm64";

export interface MatrixEntry {
	os: BuildOS;
	arch: BuildArch;
}

export interface BuildConfig {
	/** Image name (multi-image `images:` form); empty for the legacy `build:` form. */
	name: string;
	matrix: MatrixEntry[];
	dockerfile: string;
	context: string;
	image: string;
	/** Tag template; only `{{git.sha}}` and `{{git.branch}}` are supported. */
	tagPattern: string;
	push: boolean;
}

export interface DeployTarget {
	cluster: string;
	namespace: string;
	operator: string;
	crd: string;
	name: string;
}

export interface DeployConfig {
	on: string[];
	target: DeployTarget;
}

export interface E2eConfig {
	spec: string;
	baseDomain?: string;
	ref?: string;
}

export interface PublishConfig {
	npm: boolean;
	pypi: boolean;
	cargo: boolean;
	cargoCrates: string[];
	packageDir: string;
	dryRun: boolean;
}

export interface PlatformConfig {
	builds: BuildConfig[];
	deploy?: DeployConfig;
	e2e?: E2eConfig;
	publish?: PublishConfig;
}

// ---------------------------------------------------------------------------
// Detector-only additions. These never reach platform's parser; they explain
// the derivation so a human (or a `hanzo detect --explain`) can audit it.
// ---------------------------------------------------------------------------

/** Where a derived field's value came from. Evidence, not assertion. */
export interface Provenance {
	/** Dotted path into PlatformConfig, e.g. `builds[0].dockerfile`. */
	field: string;
	/** The decisive fact, e.g. `root Dockerfile` or `App hanzo/world`. */
	because: string;
	/**
	 * `tree`   — read off the repo contents alone (offline, deterministic).
	 * `cluster`— read off live operator CRs (what the fleet actually runs).
	 * `policy` — a fleet-wide constant (registry host, default branch matrix).
	 */
	source: "tree" | "cluster" | "policy";
}

/** What a repo IS. One value; the whole detector keys off it. */
export type Stack =
	| "go"
	| "node"
	| "rust"
	| "python"
	| "solidity"
	| "static"
	| "unknown";

export interface DetectResult {
	config: PlatformConfig;
	provenance: Provenance[];
	stack: Stack;
	/**
	 * True when the repo has nothing to build. Callers must treat this as
	 * "no CI", never as an empty build list — platform's validator rejects
	 * `builds: []`, and rightly so.
	 */
	deployable: boolean;
	/** Human-readable reason when `deployable` is false. */
	reason?: string;
	/**
	 * Images the tree pass declined to guess at. `withCluster` promotes the ones
	 * the fleet actually runs. Present on every result; empty for most repos.
	 */
	deferred?: DockerfileCandidateLike[];
}

/** Structural shape of a deferred image candidate (see `src/dockerfile.ts`). */
export interface DockerfileCandidateLike {
	path: string;
	name: string;
	context: string;
	because: string;
}
