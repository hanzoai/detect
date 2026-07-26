# @hanzo/detect

Derive a repo's CI/CD config from the repo. Zero runtime dependencies.

A Go module with a Dockerfile does not need a human to write down "build this Go
module with this Dockerfile" — the platform can see that. This package turns a
repo tree into the same `PlatformConfig` that `platform.hanzo.ai` already
consumes, so a repo declares config only for the things its contents genuinely
do not state.

```ts
import { detect, withCluster, fsTree } from "@hanzo/detect";

const ctx = { org: "hanzoai", repo: "world" };
const result = withCluster(detect(fsTree("/path/to/world"), ctx), clusterIndex, ctx);
// result.config.builds[0].image  → "ghcr.io/hanzoai/world"
// result.config.deploy.target    → App hanzo/world on do-sfo3-hanzo-k8s
```

## Two passes

| | reads | answers |
|---|---|---|
| `detect(tree, ctx)` | the repo only | which images, from which Dockerfile, in which context, pushed where |
| `withCluster(result, index, ctx)` | operator CRs + Deployments | corrects image names, resolves `deploy:` |

Both are pure. `detect` alone yields a complete, buildable config; the cluster
pass only ever adds evidence. `src/fs-tree.ts` is the single module that touches
a disk — every rule is tested from an in-memory tree.

### Why the cluster is an input

Where an image gets rolled out is not a property of the source, but it is not
unknowable either: the operator CRs already say it. `deploy:` is therefore a
**join** — image ref → the workload already running that image — not config.
The `hanzo.yml` that spelled it out was a copy of the cluster that could go
stale, and three in the fleet already have (see below).

## The override contract

Derived config is the default. A `hanzo.yml` exists only to state what the tree
and the cluster cannot, and it should be small. **One rule, at two levels:**

**SET** — if the file declares images at all (`images:` or `build:`), that list
*is* the set of images to build. Declaring no images means "build what you
derived". This is the only way to remove a derived image, and it needs no new
key: `hanzoai/cloud` already uses exactly this shape by hand to keep its main
image out of the platform pipeline (`release.yml` owns that one).

**FIELD** — inside a build the repo did declare, and for `deploy:` / `e2e:` /
`publish:`, the declared value wins outright.

A repo with **zero** config files gets: every production image it contains, the
right `ghcr.io/<org>` ref, and a deploy target if the fleet runs that image.
Nothing else is needed.

```yaml
# The whole file, for a repo that only needs to correct one thing.
e2e:
  spec: tests/16-pricing.spec.ts
  baseDomain: pricing.hanzo.ai
```

`irreducible(derived, declared)` reports what a file adds over detection — run
it over a repo to find out whether its config is still pulling its weight.

### Caveat, stated plainly

Platform's parser fills its own defaults (`context: "."`, a tag pattern) before
`mergeConfig` sees a declared build, so a declared build cannot distinguish
"omitted" from "explicitly the default". Derived values therefore fill only
builds the repo did **not** declare. This is why the recommended first wiring is
fallback-only — it changes nothing for a repo that already has a file.

## Wiring into platform

`scheduleBuilds` returns `null` when a repo has no config, i.e. "opted out".
Zero-config CI is that `null` becoming a derived config. In
`pkg/platform/src/services/ci/build-scheduler.ts`, `resolveSource` currently
yields `{ config }` straight from `fetchPlatformConfig`; the change is to fall
back when it is null:

```ts
// after: const { organizationId, config } = await resolveSource(...)
const effective = config ?? detectFromRepo(input.repo, input.sha);
if (!effective) return null;   // genuinely nothing to build
```

Phase 1 is fallback-only: repos that already have a `hanzo.yml` are untouched,
and the 400+ repos with none gain CI. Phase 2 swaps the `??` for
`mergeConfig(derived, config)` and the existing files shrink to their
irreducible parts.

The detector needs a tree, so `detectFromRepo` reads the repo at the SHA through
the same Hanzo Git client `fetchPlatformConfig` already uses — implement
`RepoTree` over its contents endpoint (about 20 lines; `fsTree` is the reference).

## What it cannot derive

Measured over every repo in the fleet that has a hand-written config
(`node bin/audit.ts`), these are the only things a file still has to say:

- **An image the fleet does not run.** `console-embed` and `cloud-flags` are
  build-time artifacts another repo's Dockerfile consumes via `FROM`; nothing
  deploys them, so there is no evidence they exist. `commerce-store` is declared
  but not deployed anywhere.
- **A deliberate exclusion.** `hanzoai/cloud` and `hanzoai/hanzo.ai` both
  contain a root Dockerfile they intentionally do not build here.
- **A name unrelated to its source.** `otel-collector` builds
  `cmd/o11yotelcollector/Dockerfile.selfbuild` as `ghcr.io/hanzoai/otel-collector`
  and calls it `collector`. No rule recovers that; it is a choice.
- **Which e2e spec guards a service.** `pricing` names one of universe's specs.

Everything else — Dockerfile selection, image name, registry, build context,
matrix, tag shape, deploy cluster/namespace/kind/name, publish targets — is
derived.

## Tests

```
npm test              # 41 tests: rules on fixtures + real fleet trees
npm run typecheck     # strict, noUncheckedIndexedAccess
npm run typecheck:seam # our PlatformConfig ↔ platform's, both directions
```

`test/fixtures/` holds a real snapshot of 17 fleet repos and the live operator-CR
index, so the fleet tests are hermetic but not synthetic. Regenerate with
`bin/snapshot-trees.ts` and `bin/cluster-index.ts`; the diff is the review.

## Tools

| | |
|---|---|
| `bin/cluster-index.ts` | build a `ClusterIndex` from live clusters (read-only `kubectl get`) |
| `bin/snapshot-trees.ts` | freeze real repo trees into a test fixture |
| `bin/audit.ts` | per-repo derived-vs-declared diff |
| `bin/sweep.ts` | fleet-wide counts: how many repos need any config at all |
