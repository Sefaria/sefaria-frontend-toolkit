import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { extract } from "tar";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  boundedResponse,
  captureDraft,
  githubClient,
  inspectNpmTarball,
  verifyAnonymousConsumer,
  verifyNpm,
} from "./npm-release.mjs";
import {
  PACKAGE_DEFINITIONS,
  releaseVersionSchema,
  sourceShaSchema,
  stagePublishPackages,
  listFiles,
} from "./package-publication.mjs";
import { verifyHostedCdn } from "./verify-npm-cdn.mjs";
import { moduleUrls } from "./site-module-urls.mjs";
import { testPromotionSite } from "./test-pages-promotion.mjs";

const owner = "Sefaria";
const { AbortSignal } = globalThis;
const repo = "sefaria-frontend-toolkit";
const siteUrl = `https://sefaria.github.io/${repo}/`;
const bootstrap = {
  source: "47226ba0d4cb5ac8b018829e987376deaee6ea09",
  runId: "37920138687",
  version: "0.1.0-alpha.0",
  releaseSource: "2d9cade6cc5b517d1ee4189e3a8d6e636cacde90",
};
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: sourceShaSchema,
    version: releaseVersionSchema,
    releaseSource: sourceShaSchema,
    runId: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();

export function selectPagesSource({
  operation,
  head,
  baseline,
  source,
  version,
  releaseSource,
}) {
  if (operation === "candidate")
    return {
      source: sourceShaSchema.parse(head),
      version: null,
      releaseSource: null,
    };
  if (operation === "maintain") return receiptSchema.parse(baseline);
  if (operation !== "promote") throw new Error("Unknown Pages operation.");
  return {
    source: sourceShaSchema.parse(source),
    version: releaseVersionSchema.parse(version),
    releaseSource: sourceShaSchema.parse(releaseSource),
  };
}

export function resolveBaseline({ deployment, receipt }) {
  if (receipt !== undefined) {
    const value = receiptSchema.parse(receipt);
    if (value.runId !== deployment.runId)
      throw new Error(
        "Stale documentation receipt; deployment identity differs.",
      );
    return value;
  }
  if (
    deployment.runId !== bootstrap.runId ||
    deployment.sha !== bootstrap.source
  )
    throw new Error(
      "Missing documentation receipt outside the recorded bootstrap deployment.",
    );
  return { schemaVersion: 1, ...bootstrap };
}

export function assertRuntimeArtifacts(released, candidate) {
  const descriptive = new Set([
    "description",
    "keywords",
    "homepage",
    "repository",
    "bugs",
    "author",
    "contributors",
    "funding",
    "readme",
    "readmeFilename",
  ]);
  for (const key of new Set([
    ...Object.keys(released.manifest),
    ...Object.keys(candidate.manifest),
  ])) {
    if (descriptive.has(key)) continue;
    if (!isDeepStrictEqual(released.manifest[key], candidate.manifest[key]))
      throw new Error(`Candidate runtime manifest differs: ${key}.`);
  }
  const runtime = (files) =>
    new Map(
      [...files].filter(
        ([file]) =>
          file.startsWith("dist/") ||
          file === "custom-elements.json" ||
          file === "LICENSE",
      ),
    );
  const original = runtime(released.files);
  const current = runtime(candidate.files);
  if (original.size !== current.size || original.size === 0)
    throw new Error("Candidate runtime inventory differs.");
  for (const [file, bytes] of original)
    if (!current.get(file)?.equals(bytes))
      throw new Error(
        `Candidate runtime differs from released artifact: ${file}.`,
      );
}

export async function qualifyPromotion(receipt, stages) {
  const value = receiptSchema.parse(receipt);
  for (const stage of ["capture", "npm", "cdn", "artifacts", "site"])
    await stages[stage]();
  return value;
}

export function assertPublicHandoff(captured) {
  if (captured.release.draft)
    throw new Error(
      "Future documentation promotion requires the public original release handoff.",
    );
}

export async function assertSiteModules(directory, version, basePath) {
  const seen = new Set();
  const urls = moduleUrls(version, basePath);
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:html|js|json|txt)$/u.test(entry.name)) {
        const text = await readFile(file, "utf8");
        for (const [before, after] of Object.entries(urls)) {
          if (before !== after && text.includes(before))
            throw new Error(
              `Unbound legacy module URL in production: ${file}.`,
            );
          if (text.includes(after)) seen.add(after);
        }
      }
    }
  }
  await walk(directory);
  if (seen.size !== 3)
    throw new Error(
      "All three literal snippet module URLs must be bound by the site build.",
    );
}

export async function readBaseline(
  api,
  { fetch: fetchResponse = globalThis.fetch } = {},
) {
  const { data: deployments } = await api.repos.listDeployments({
    owner,
    repo,
    environment: "github-pages",
    per_page: 100,
  });
  let deployment;
  for (const record of deployments) {
    const { data: statuses } = await api.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: record.id,
      per_page: 1,
    });
    if (statuses[0]?.state !== "success") continue;
    const runId = /\/actions\/runs\/([1-9]\d*)\/job\//u.exec(
      statuses[0].log_url ?? "",
    )?.[1];
    if (!runId)
      throw new Error("Successful Pages deployment has no producer identity.");
    deployment = { runId, sha: record.sha };
    break;
  }
  if (!deployment)
    throw new Error("No successful Pages deployment in the bounded inventory.");
  const response = await fetchResponse(
    `${siteUrl}documentation-release.json?run=${deployment.runId}`,
    {
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (response.status === 404) return resolveBaseline({ deployment });
  if (!response.ok)
    throw new Error(
      `Cannot read deployed documentation receipt (${response.status}).`,
    );
  const receipt = JSON.parse(
    (await boundedResponse(response, 10_000)).toString("utf8"),
  );
  return resolveBaseline({ deployment, receipt });
}

function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

export function assertDocumentationSource({ source, releaseHead }) {
  sourceShaSchema.parse(source);
  sourceShaSchema.parse(releaseHead);
  if (source !== releaseHead)
    throw new Error(
      "Documentation source must equal the current release/docs tip.",
    );
}

export function assertDeploymentUnchanged(expectedRunId, baseline) {
  const runId = receiptSchema.shape.runId.parse(expectedRunId);
  if (receiptSchema.parse(baseline).runId !== runId)
    throw new Error(
      "Deployed documentation changed during qualification; select the current deployment and run again.",
    );
}

export async function candidateArtifacts(root, captured, directory) {
  const staging = path.join(root, ".artifacts", "pages-staging");
  await stagePublishPackages({
    repository: root,
    destination: staging,
    version: captured.manifest.version,
  });
  const extracted = await mkdtemp(
    path.join(tmpdir(), "sefaria-pages-runtime-"),
  );
  try {
    for (const [index, definition] of PACKAGE_DEFINITIONS.entries()) {
      const filename = path.join(
        directory,
        captured.manifest.packages[index].filename,
      );
      await inspectNpmTarball(filename, definition, captured.manifest.version);
      const destination = path.join(extracted, definition.slug);
      await mkdir(destination);
      await extract({ file: filename, cwd: destination, strict: true });
      async function artifact(packageRoot) {
        const files = await listFiles(packageRoot);
        return {
          manifest: JSON.parse(
            await readFile(path.join(packageRoot, "package.json"), "utf8"),
          ),
          files: new Map(
            await Promise.all(
              files.map(async (file) => [
                file,
                await readFile(path.join(packageRoot, file)),
              ]),
            ),
          ),
        };
      }
      assertRuntimeArtifacts(
        await artifact(path.join(destination, "package")),
        await artifact(path.join(staging, definition.slug)),
      );
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

async function main() {
  const operation = process.argv[2];
  if (operation === "resolve") {
    const mode = process.env.PAGES_OPERATION;
    const baseline =
      mode === "candidate"
        ? undefined
        : await readBaseline(githubClient(process.env.GITHUB_TOKEN));
    const currentCorrection = process.env.CURRENT_RELEASE_CORRECTION === "true";
    const selected = selectPagesSource({
      operation: mode,
      head: process.env.CANDIDATE_SOURCE,
      source: currentCorrection
        ? process.env.CANDIDATE_SOURCE
        : process.env.DOCS_SOURCE,
      version: currentCorrection
        ? baseline.version
        : process.env.RELEASE_VERSION,
      releaseSource: currentCorrection
        ? baseline.releaseSource
        : process.env.RELEASE_SOURCE,
      baseline,
    });
    for (const sha of [selected.source, selected.releaseSource].filter(
      Boolean,
    )) {
      git(["cat-file", "-e", `${sha}^{commit}`]);
    }
    if (mode === "candidate")
      git(["merge-base", "--is-ancestor", selected.source, "origin/main"]);
    else {
      git([
        "merge-base",
        "--is-ancestor",
        selected.releaseSource,
        "origin/main",
      ]);
      if (mode === "promote")
        assertDocumentationSource({
          source: selected.source,
          releaseHead: git(["rev-parse", "origin/release/docs"]),
        });
    }
    if (baseline)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `baselineRunId=${baseline.runId}\n`,
      );
    for (const [key, value] of Object.entries(selected))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value ?? ""}\n`);
    return;
  }
  const root = process.cwd();
  const source = sourceShaSchema.parse(process.env.DOCS_SOURCE);
  if (git(["rev-parse", "HEAD"]) !== source)
    throw new Error("Documentation checkout source differs.");
  if (operation === "preview") {
    await assertSiteModules(
      path.join(root, "dist", "site"),
      null,
      "/sefaria-frontend-toolkit/",
    );
    return;
  }
  const version = process.env.RELEASE_VERSION;
  const releaseSource = process.env.RELEASE_SOURCE;
  const receipt = receiptSchema.parse({
    schemaVersion: 1,
    source,
    version,
    releaseSource,
    runId: process.env.GITHUB_RUN_ID,
  });
  const directory = path.join(root, ".artifacts", "pages-release");
  let captured;
  if (operation === "qualify") {
    await qualifyPromotion(receipt, {
      capture: async () => {
        const api = githubClient(process.env.GITHUB_TOKEN);
        captured = await captureDraft(api, {
          version,
          source: releaseSource,
          directory,
        });
        assertPublicHandoff(captured);
      },
      npm: async () => {
        await verifyNpm(captured);
        await verifyAnonymousConsumer(captured.manifest);
      },
      cdn: async () => {
        await verifyHostedCdn(captured);
      },
      artifacts: async () => {
        await candidateArtifacts(root, captured, directory);
      },
      site: async () => {
        const recommendation = z
          .object({ version: releaseVersionSchema })
          .strict()
          .parse(
            JSON.parse(
              await readFile(
                path.join(root, "scripts", "npm-documentation-release.json"),
                "utf8",
              ),
            ),
          );
        if (recommendation.version !== version)
          throw new Error(
            "Documentation recommendation does not select the qualified release version.",
          );
        await assertSiteModules(
          path.join(root, "dist", "site"),
          version,
          "/sefaria-frontend-toolkit/",
        );
        await testPromotionSite({
          root,
          version,
          basePath: "/sefaria-frontend-toolkit/",
        });
      },
    });
    return;
  }
  if (operation !== "receipt")
    throw new Error("Expected resolve, qualify, preview or receipt.");
  assertDeploymentUnchanged(
    process.env.DEPLOYED_RUN_ID,
    await readBaseline(githubClient(process.env.GITHUB_TOKEN)),
  );
  if (process.env.PAGES_OPERATION === "promote") {
    git(["fetch", "--quiet", "origin", "release/docs"]);
    assertDocumentationSource({
      source,
      releaseHead: git(["rev-parse", "origin/release/docs"]),
    });
  }
  await writeFile(
    path.join(root, "dist", "site", "documentation-release.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
