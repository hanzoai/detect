#!/usr/bin/env node
/**
 * Build a `ClusterIndex` from live clusters. READ-ONLY: `kubectl get`, nothing
 * else, ever.
 *
 * Operator CRs (`App`/`Service`) become deploy targets. Plain `Deployment`s are
 * indexed too but only as evidence that an image ref exists — `resolveDeploy`
 * refuses to target them, because the operator does not own them.
 *
 *   node bin/cluster-index.ts do-sfo3-hanzo-k8s do-sfo3-lux-k8s > index.json
 */
import { execFileSync } from "node:child_process";
import type { WorkloadRef } from "../src/deploy.ts";

interface K8sList {
	items?: Array<{
		kind: string;
		metadata: { name: string; namespace: string };
		spec?: Record<string, unknown>;
	}>;
}

function kubectl(context: string, args: string[]): K8sList {
	const out = execFileSync(
		"kubectl",
		["--context", context, "--request-timeout=30s", ...args, "-o", "json"],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	return JSON.parse(out) as K8sList;
}

/** Strip a tag/digest from an image reference. */
export function repoOf(image: string): string {
	const slash = image.lastIndexOf("/");
	const at = image.indexOf("@");
	if (at !== -1) return image.slice(0, at);
	const colon = image.indexOf(":", slash === -1 ? 0 : slash);
	return colon === -1 ? image : image.slice(0, colon);
}

/** `spec.image` is either a string or `{ repository, tag }` across the fleet. */
function specImageRepo(spec: Record<string, unknown> | undefined): string | null {
	const image = spec?.image;
	if (typeof image === "string") return repoOf(image);
	if (image && typeof image === "object") {
		const r = (image as Record<string, unknown>).repository ?? (image as Record<string, unknown>).repo;
		if (typeof r === "string") return r;
	}
	return null;
}

function crs(context: string): WorkloadRef[] {
	const out: WorkloadRef[] = [];
	for (const it of kubectl(context, ["get", "apps.hanzo.ai,services.hanzo.ai", "-A"]).items ?? []) {
		const imageRepo = specImageRepo(it.spec);
		if (!imageRepo) continue;
		out.push({
			cluster: context,
			namespace: it.metadata.namespace,
			kind: it.kind,
			name: it.metadata.name,
			imageRepo,
		});
	}
	return out;
}

function deployments(context: string): WorkloadRef[] {
	const out: WorkloadRef[] = [];
	for (const it of kubectl(context, ["get", "deployments", "-A"]).items ?? []) {
		const containers =
			((it.spec as Record<string, unknown> | undefined)?.template as
				| { spec?: { containers?: Array<{ image?: string }> } }
				| undefined)?.spec?.containers ?? [];
		for (const c of containers) {
			if (!c.image) continue;
			out.push({
				cluster: context,
				namespace: it.metadata.namespace,
				kind: "Deployment",
				name: it.metadata.name,
				imageRepo: repoOf(c.image),
			});
		}
	}
	return out;
}

/** Index every named cluster. A cluster that cannot be reached is skipped. */
export function buildIndex(contexts: string[]): WorkloadRef[] {
	const out: WorkloadRef[] = [];
	for (const ctx of contexts) {
		for (const fn of [crs, deployments]) {
			try {
				out.push(...fn(ctx));
			} catch (err) {
				process.stderr.write(`skip ${ctx} ${fn.name}: ${(err as Error).message.split("\n")[0]}\n`);
			}
		}
	}
	// Deterministic order so a regenerated fixture diffs cleanly.
	return out.sort((a, b) =>
		`${a.cluster}/${a.namespace}/${a.kind}/${a.name}/${a.imageRepo}`.localeCompare(
			`${b.cluster}/${b.namespace}/${b.kind}/${b.name}/${b.imageRepo}`,
		),
	);
}

if (process.argv[1]?.endsWith("cluster-index.ts")) {
	const contexts = process.argv.slice(2);
	if (contexts.length === 0) {
		process.stderr.write("usage: cluster-index.ts <kube-context>...\n");
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(buildIndex(contexts), null, "\t")}\n`);
}
