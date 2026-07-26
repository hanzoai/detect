/**
 * Rule-level tests on in-memory fixtures. Every case is a shape that exists in
 * the fleet; `test/fleet.test.ts` then runs the same rules over the real trees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { memTree } from "../src/tree.ts";
import { contextFor, imageNameFor, selectImages, suffixOf } from "../src/dockerfile.ts";
import { imageRefFor, namespaceFor } from "../src/registry.ts";
import { detectStack } from "../src/stack.ts";
import { detectPublish } from "../src/publish.ts";
import { detect, withCluster } from "../src/detect.ts";
import { imageAliases, rankWorkloads, resolveDeploy, type ClusterIndex } from "../src/deploy.ts";
import { irreducible, mergeConfig } from "../src/merge.ts";
import type { PlatformConfig } from "../src/types.ts";

const DF = "FROM scratch\n";

test("namespaceFor maps every fleet org spelling to its registry", () => {
	assert.equal(namespaceFor("hanzo"), "hanzoai");
	assert.equal(namespaceFor("hanzoai"), "hanzoai");
	assert.equal(namespaceFor("HanzoAI"), "hanzoai");
	assert.equal(namespaceFor("luxfi"), "luxfi");
	assert.equal(namespaceFor("lux"), "luxfi");
	assert.equal(namespaceFor("zooai"), "zooai");
	assert.equal(namespaceFor("zoo"), "zooai");
	// Unknown org maps to itself — never a silent cross-org write.
	assert.equal(namespaceFor("adnexus"), "adnexus");
	assert.equal(imageRefFor("hanzo", "iam"), "ghcr.io/hanzoai/iam");
	assert.equal(imageRefFor("luxfi", "node"), "ghcr.io/luxfi/node");
});

test("suffixOf splits Dockerfile variants", () => {
	assert.equal(suffixOf("Dockerfile"), null);
	assert.equal(suffixOf("docker/Dockerfile"), null);
	assert.equal(suffixOf("Dockerfile.production"), "production");
	assert.equal(suffixOf("a/b/Dockerfile.commerce-admin"), "commerce-admin");
});

test("imageNameFor reproduces every naming shape in the fleet", () => {
	assert.equal(imageNameFor("Dockerfile", "iam"), "iam");
	assert.equal(imageNameFor("Dockerfile.production", "app"), "app");
	assert.equal(imageNameFor("Dockerfile.api", "exchange"), "exchange-api");
	assert.equal(imageNameFor("Dockerfile.embed", "console"), "console-embed");
	// Suffix that already carries the repo prefix is not doubled.
	assert.equal(imageNameFor("Dockerfile.commerce-admin", "commerce"), "commerce-admin");
	// Build directories name nothing.
	assert.equal(imageNameFor("docker/Dockerfile", "node"), "node");
	assert.equal(imageNameFor("deploy/Dockerfile", "base"), "base");
	// A component directory does.
	assert.equal(imageNameFor("native/flags/Dockerfile", "cloud"), "cloud-flags");
	// Go's cmd/<x> is the binary name.
	assert.equal(imageNameFor("cmd/hanzod/Dockerfile", "node"), "hanzod");
});

test("contextFor is '.' unless the Dockerfile's dir is self-contained", () => {
	const tree = memTree({
		Dockerfile: DF,
		"native/flags/Dockerfile": DF,
		"native/flags/Cargo.toml": "[package]\nname = \"flags\"\n",
		"cmd/collector/Dockerfile": DF,
		"cmd/collector/main.go": "package main",
	});
	assert.equal(contextFor(tree, "Dockerfile"), ".");
	assert.equal(contextFor(tree, "native/flags/Dockerfile"), "native/flags");
	// cmd/collector has no manifest of its own — it builds from the repo root.
	assert.equal(contextFor(tree, "cmd/collector/Dockerfile"), ".");
});

test("dev variants are dropped, release variants supersede the plain Dockerfile", () => {
	const tree = memTree({
		Dockerfile: DF,
		"Dockerfile.production": DF,
		"Dockerfile.dev": DF,
		"docker/Dockerfile.dev": DF,
	});
	const { chosen, deferred } = selectImages(tree, "app");
	assert.deepEqual(
		chosen.map((c) => [c.name, c.path]),
		[["app", "Dockerfile.production"]],
	);
	assert.equal(deferred.length, 0, "dev variants are dropped, not deferred");
});

test("suffixed images are DEFERRED, never guessed, when a plain Dockerfile exists", () => {
	const tree = memTree({
		Dockerfile: DF,
		"Dockerfile.v2": DF,
		"Dockerfile.goonly": DF,
	});
	const { chosen, deferred } = selectImages(tree, "iam");
	assert.deepEqual(chosen.map((c) => c.name), ["iam"]);
	assert.deepEqual(deferred.map((c) => c.name).sort(), ["iam-goonly", "iam-v2"]);
});

test("a repo whose only Dockerfiles are suffixed builds them all", () => {
	const tree = memTree({ "Dockerfile.api": DF, "Dockerfile.worker": DF });
	const { chosen, deferred } = selectImages(tree, "svc");
	assert.deepEqual(chosen.map((c) => c.name).sort(), ["svc-api", "svc-worker"]);
	assert.equal(deferred.length, 0);
});

test("skip-dirs keep vendored trees out of the image set", () => {
	const tree = memTree({
		Dockerfile: DF,
		"node_modules/foo/Dockerfile": DF,
		"vendor/bar/Dockerfile": DF,
		"testdata/Dockerfile": DF,
		".git/Dockerfile": DF,
	});
	assert.deepEqual(selectImages(tree, "svc").chosen.map((c) => c.path), ["Dockerfile"]);
});

test("detectStack picks the toolchain the Dockerfile actually uses", () => {
	// The real hanzoai/world shape: go.mod AND a Vite app; the image is the SPA.
	const world = memTree({
		"go.mod": "module github.com/hanzoai/world\n",
		"package.json": JSON.stringify({ name: "@hanzo/world", private: true }),
		"vite.config.ts": "export default {}",
		Dockerfile: "FROM node:22 AS build\nRUN npm ci && npm run build\n",
	});
	assert.equal(detectStack(world, ["Dockerfile"]), "node");
	// Same tree, a Go Dockerfile — same manifests, different answer.
	const goish = memTree({
		"go.mod": "module x\n",
		"package.json": JSON.stringify({ name: "x" }),
		Dockerfile: "FROM golang:1.26 AS build\nRUN go build ./cmd/x\n",
	});
	assert.equal(detectStack(goish, ["Dockerfile"]), "go");
	assert.equal(detectStack(memTree({ "go.mod": "module x" })), "go");
	assert.equal(detectStack(memTree({})), "unknown");
});

test("detectPublish reads the package manifest, and honours opt-outs", () => {
	assert.deepEqual(detectPublish(memTree({ "package.json": '{"name":"@hanzo/sdk"}' })), {
		npm: true, pypi: false, cargo: false, cargoCrates: [], packageDir: ".", dryRun: false,
	});
	// private: true is npm's own opt-out.
	assert.equal(detectPublish(memTree({ "package.json": '{"name":"x","private":true}' })), undefined);
	// publish = false is cargo's.
	assert.equal(
		detectPublish(memTree({ "Cargo.toml": '[package]\nname = "x"\npublish = false\n' })),
		undefined,
	);
	assert.equal(detectPublish(memTree({ "Cargo.toml": "[workspace]\nmembers = []\n" })), undefined);
	const py = detectPublish(memTree({ "pyproject.toml": '[project]\nname = "x"\n' }));
	assert.equal(py?.pypi, true);
	assert.equal(detectPublish(memTree({ "go.mod": "module x" })), undefined);
});

test("a repo with no Dockerfile is not deployable and yields no empty build list", () => {
	const r = detect(memTree({ "go.mod": "module x\n", "x.go": "package x" }), {
		org: "luxfi", repo: "consensus",
	});
	assert.equal(r.deployable, false);
	assert.equal(r.config.builds.length, 0);
	assert.match(r.reason ?? "", /no Dockerfile/);
});

test("detect produces a config platform's own defaults would accept", () => {
	const r = detect(memTree({ Dockerfile: DF, "go.mod": "module x\n" }), {
		org: "hanzo", repo: "tasks",
	});
	assert.equal(r.deployable, true);
	assert.deepEqual(r.config.builds, [
		{
			name: "tasks",
			matrix: [{ os: "linux", arch: "amd64" }],
			dockerfile: "Dockerfile",
			context: ".",
			image: "ghcr.io/hanzoai/tasks",
			tagPattern: "{{git.sha}}-amd64-tasks",
			push: true,
		},
	]);
	assert.equal(r.config.deploy, undefined, "offline pass cannot know the target");
});

test("detect is a pure function — same tree, identical output", () => {
	const files = { Dockerfile: DF, "go.mod": "module x\n", "e2e/a.spec.ts": "" };
	const a = detect(memTree(files), { org: "hanzo", repo: "tasks" });
	const b = detect(memTree(files), { org: "hanzo", repo: "tasks" });
	assert.deepEqual(a, b);
});

// --- cluster pass -----------------------------------------------------------

const INDEX: ClusterIndex = [
	{ cluster: "do-sfo3-hanzo-k8s", namespace: "hanzo", kind: "App", name: "hanzo-app", imageRepo: "ghcr.io/hanzoai/hanzo-app" },
	{ cluster: "do-sfo3-hanzo-k8s", namespace: "hanzo", kind: "App", name: "commerce-admin", imageRepo: "ghcr.io/hanzoai/commerce-admin" },
	{ cluster: "do-sfo3-hanzo-k8s", namespace: "hanzo-devnet", kind: "App", name: "commerce", imageRepo: "ghcr.io/hanzoai/commerce" },
	{ cluster: "do-sfo3-hanzo-k8s", namespace: "hanzo", kind: "App", name: "world", imageRepo: "ghcr.io/hanzoai/world" },
	{ cluster: "do-sfo3-lux-k8s", namespace: "lux-ns", kind: "Deployment", name: "lux-exchange", imageRepo: "ghcr.io/luxfi/exchange" },
];

test("imageAliases offers the brand-prefixed form once", () => {
	assert.deepEqual(imageAliases("app", "hanzoai"), ["app", "hanzo-app"]);
	assert.deepEqual(imageAliases("hanzo-app", "hanzoai"), ["hanzo-app"]);
	assert.deepEqual(imageAliases("node", "luxfi"), ["node", "lux-node"]);
});

test("cluster pass renames an image the repo name alone gets wrong", () => {
	const base = detect(memTree({ "Dockerfile.production": DF, "package.json": '{"name":"app"}' }), {
		org: "hanzoai", repo: "app",
	});
	assert.equal(base.config.builds[0]?.image, "ghcr.io/hanzoai/app");
	const r = withCluster(base, INDEX, { org: "hanzoai", repo: "app" });
	assert.equal(r.config.builds[0]?.image, "ghcr.io/hanzoai/hanzo-app");
	assert.equal(r.config.builds[0]?.name, "hanzo-app");
	assert.equal(r.config.builds[0]?.tagPattern, "{{git.sha}}-amd64-hanzo-app");
	assert.deepEqual(r.config.deploy?.target, {
		cluster: "do-sfo3-hanzo-k8s", namespace: "hanzo",
		operator: "hanzo-operator", crd: "App", name: "hanzo-app",
	});
	assert.deepEqual(r.config.deploy?.on, ["main"]);
});

test("cluster pass promotes a deferred image the fleet runs, and only that one", () => {
	const tree = memTree({
		Dockerfile: DF,
		"Dockerfile.production": DF,
		"Dockerfile.commerce-admin": DF,
		"Dockerfile.sqfix": DF,
		"go.mod": "module commerce\n",
	});
	const base = detect(tree, { org: "hanzoai", repo: "commerce" });
	assert.deepEqual(base.config.builds.map((b) => b.name), ["commerce"]);
	assert.deepEqual(base.deferred?.map((c) => c.name).sort(), ["commerce-admin", "commerce-sqfix"]);
	const r = withCluster(base, INDEX, { org: "hanzoai", repo: "commerce" });
	assert.deepEqual(
		r.config.builds.map((b) => b.name).sort(),
		["commerce", "commerce-admin"],
		"the live admin image is promoted; the dead sqfix variant is not",
	);
});

test("a plain Deployment proves an image exists but can never be a deploy target", () => {
	const base = detect(memTree({ Dockerfile: DF, "package.json": '{"name":"x","private":true}' }), {
		org: "luxfi", repo: "exchange",
	});
	const r = withCluster(base, INDEX, { org: "luxfi", repo: "exchange" });
	assert.equal(r.config.builds[0]?.image, "ghcr.io/luxfi/exchange");
	assert.equal(r.config.deploy, undefined, "Deployments are not operator-owned");
});

test("no workload for an image means no deploy block, not a wrong one", () => {
	const base = detect(memTree({ Dockerfile: DF }), { org: "hanzoai", repo: "nowhere" });
	const r = withCluster(base, INDEX, { org: "hanzoai", repo: "nowhere" });
	assert.equal(r.config.deploy, undefined);
});

test("rankWorkloads prefers the production namespace, then the exact name", () => {
	const ranked = rankWorkloads([
		{ cluster: "c", namespace: "hanzo-devnet", kind: "App", name: "iam", imageRepo: "ghcr.io/hanzoai/iam" },
		{ cluster: "c", namespace: "hanzo", kind: "App", name: "iam", imageRepo: "ghcr.io/hanzoai/iam" },
		{ cluster: "c", namespace: "hanzo", kind: "App", name: "iam-canary", imageRepo: "ghcr.io/hanzoai/iam" },
	]);
	assert.deepEqual(ranked.map((w) => `${w.namespace}/${w.name}`), [
		"hanzo/iam", "hanzo/iam-canary", "hanzo-devnet/iam",
	]);
});

test("resolveDeploy reports the other places the same image runs", () => {
	const out = resolveDeploy(
		[
			{ cluster: "c", namespace: "hanzo", kind: "App", name: "iam", imageRepo: "ghcr.io/hanzoai/iam" },
			{ cluster: "c", namespace: "hanzo-testnet", kind: "App", name: "iam", imageRepo: "ghcr.io/hanzoai/iam" },
		],
		"ghcr.io/hanzoai/iam",
	);
	assert.equal(out?.deploy.target.namespace, "hanzo");
	assert.deepEqual(out?.alternatives.map((w) => w.namespace), ["hanzo-testnet"]);
});

// --- override contract ------------------------------------------------------

const derived: PlatformConfig = {
	builds: [
		{ name: "cloud", matrix: [{ os: "linux", arch: "amd64" }], dockerfile: "Dockerfile", context: ".", image: "ghcr.io/hanzoai/cloud", tagPattern: "{{git.sha}}-amd64-cloud", push: true },
	],
	deploy: { on: ["main"], target: { cluster: "c", namespace: "hanzo", operator: "hanzo-operator", crd: "App", name: "cloud" } },
};

test("no config at all → the derived config, unchanged", () => {
	assert.deepEqual(mergeConfig(derived, undefined), derived);
});

test("a declared image list is authoritative — this is how a repo REMOVES a build", () => {
	// hanzoai/cloud's real shape: build only the flags staticlib, never the main
	// image (release.yml owns that one). No new key needed to express it.
	const declared: PlatformConfig = {
		builds: [
			{ name: "cloud-flags", matrix: [{ os: "linux", arch: "amd64" }], dockerfile: "native/flags/Dockerfile", context: "native/flags", image: "ghcr.io/hanzoai/cloud-flags", tagPattern: "{{git.sha}}-amd64-cloud-flags", push: true },
		],
	};
	const merged = mergeConfig(derived, declared);
	assert.deepEqual(merged.builds.map((b) => b.name), ["cloud-flags"]);
	// deploy was NOT declared, so the derived one survives.
	assert.deepEqual(merged.deploy, derived.deploy);
});

test("a config that declares only deploy keeps every derived build", () => {
	const declared: PlatformConfig = {
		builds: [],
		deploy: { on: ["main", "release"], target: { cluster: "c2", namespace: "hanzo", operator: "hanzo-operator", crd: "App", name: "other" } },
	};
	const merged = mergeConfig(derived, declared);
	assert.deepEqual(merged.builds, derived.builds);
	assert.equal(merged.deploy?.target.name, "other");
	assert.deepEqual(merged.deploy?.on, ["main", "release"]);
});

test("irreducible names exactly what the file adds over detection", () => {
	const declared: PlatformConfig = {
		builds: [
			{ name: "cloud-flags", matrix: [{ os: "linux", arch: "amd64" }], dockerfile: "native/flags/Dockerfile", context: "native/flags", image: "ghcr.io/hanzoai/cloud-flags", tagPattern: "t", push: true },
		],
	};
	assert.deepEqual(irreducible(derived, declared), [
		"builds[cloud-flags] — not derived at all",
		"builds[cloud] — derived but deliberately not declared",
	]);
	// A file that restates the derivation adds nothing.
	assert.deepEqual(irreducible(derived, derived), []);
});

test("the component fallback is bounded — a 20-Dockerfile monorepo is not guessed at", () => {
	// hanzoai/pipelines (a Kubeflow fork) shape: no root Dockerfile, many
	// component images. Unbounded this scheduled 15 builds nobody asked for.
	const files: Record<string, string> = {};
	for (const c of ["proxy", "frontend", "backend", "tools/kind", "test/release", "components/kserve"]) {
		files[`${c}/Dockerfile`] = DF;
	}
	const { chosen, deferred } = selectImages(memTree(files), "pipelines");
	assert.equal(chosen.length, 0, "6 nested components is past the cap — declare them");
	assert.equal(deferred.length, 6, "…but they are still offered to the cluster pass");

	// Exactly at the cap it still derives, so otel-collector's two cmd/ images work.
	const small = memTree({ "cmd/a/Dockerfile": DF, "cmd/b/Dockerfile": DF });
	assert.deepEqual(selectImages(small, "svc").chosen.map((c) => c.name), ["a", "b"]);
});
