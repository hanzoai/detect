/**
 * `@hanzo/detect` — derive a repo's CI/CD config from the repo.
 *
 * Zero runtime dependencies. `src/fs-tree.ts` is the only module that touches
 * a disk; everything else is a pure function over `RepoTree`.
 */
export { detect, withCluster, type RepoContext } from "./detect.ts";
export { mergeConfig, irreducible } from "./merge.ts";
export { fsTree } from "./fs-tree.ts";
export { memTree, type RepoTree } from "./tree.ts";
export {
	imageAliases,
	rankWorkloads,
	resolveDeploy,
	workloadsForImage,
	type ClusterIndex,
	type WorkloadRef,
} from "./deploy.ts";
export { imageRefFor, namespaceFor, REGISTRY_HOST } from "./registry.ts";
export {
	contextFor,
	findDockerfiles,
	imageNameFor,
	selectImages,
	suffixOf,
	type DockerfileCandidate,
} from "./dockerfile.ts";
export { detectStack, stacksPresent } from "./stack.ts";
export { detectPublish, isJsWorkspaceRoot } from "./publish.ts";
export type {
	BuildConfig,
	DeployConfig,
	DeployTarget,
	DetectResult,
	E2eConfig,
	MatrixEntry,
	PlatformConfig,
	Provenance,
	PublishConfig,
	Stack,
} from "./types.ts";
