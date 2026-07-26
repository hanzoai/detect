/**
 * Seam check, at COMPILE time.
 *
 * `src/types.ts` mirrors platform's `PlatformConfig` so the detector can stay
 * dependency-free. A mirror that silently drifts from the thing it mirrors is
 * worse than no mirror at all, so this file assigns each type to the other in
 * BOTH directions: add a required field on either side, or change one's shape,
 * and `pnpm typecheck` fails here rather than in production.
 *
 * Type-only imports — nothing from platform is executed, and this file is not
 * part of the runtime test run (`*.test.ts`); it exists for `tsc`.
 *
 * The path is relative to a sibling checkout of hanzoai/platform. When the
 * detector lands inside platform this becomes a plain intra-repo import and the
 * mirror can be deleted outright.
 */
import type {
	BuildConfig as PlatformBuildConfig,
	DeployConfig as PlatformDeployConfig,
	E2eConfig as PlatformE2eConfig,
	MatrixEntry as PlatformMatrixEntry,
	PlatformConfig as PlatformPlatformConfig,
	PublishConfig as PlatformPublishConfig,
} from "../../platform/pkg/platform/src/services/ci/platform-config.ts";

import type {
	BuildConfig,
	DeployConfig,
	E2eConfig,
	MatrixEntry,
	PlatformConfig,
	PublishConfig,
} from "../src/types.ts";

/** `Assert<A, B>` compiles only when A is assignable to B. */
type Assert<A extends B, B> = A;

// Ours → theirs: what detect() emits is what platform accepts.
export type _M1 = Assert<MatrixEntry, PlatformMatrixEntry>;
export type _B1 = Assert<BuildConfig, PlatformBuildConfig>;
export type _D1 = Assert<DeployConfig, PlatformDeployConfig>;
export type _E1 = Assert<E2eConfig, PlatformE2eConfig>;
export type _P1 = Assert<PublishConfig, PlatformPublishConfig>;
export type _C1 = Assert<PlatformConfig, PlatformPlatformConfig>;

// Theirs → ours: a config parsed from a hanzo.yml can be merged with a derived
// one, so `mergeConfig(derived, declared)` type-checks on real parser output.
export type _M2 = Assert<PlatformMatrixEntry, MatrixEntry>;
export type _B2 = Assert<PlatformBuildConfig, BuildConfig>;
export type _D2 = Assert<PlatformDeployConfig, DeployConfig>;
export type _E2 = Assert<PlatformE2eConfig, E2eConfig>;
export type _P2 = Assert<PlatformPublishConfig, PublishConfig>;
export type _C2 = Assert<PlatformPlatformConfig, PlatformConfig>;
