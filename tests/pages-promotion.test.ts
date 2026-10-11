import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertRuntimeArtifacts,
  qualifyPromotion,
  resolveBaseline,
  readBaseline,
  selectPagesSource,
  assertSiteModules,
  assertPublicHandoff,
  assertDocumentationSource,
  assertDeploymentUnchanged,
} from "../scripts/pages-promotion.mjs";
import {
  moduleUrls,
  siteModuleUrlsPlugin,
} from "../scripts/site-module-urls.mjs";

const source = "a".repeat(40);
const releaseSource = "b".repeat(40);
const receipt = {
  schemaVersion: 1,
  source,
  version: "0.1.0-alpha.0",
  releaseSource,
  runId: "123",
};

describe("documentation promotion", () => {
  it.each(["clean", "conflicting"])(
    "accepts a %s main-first backport and the next release without shared correction commits",
    async (context) => {
      const repository = await mkdtemp(path.join(tmpdir(), "pages-history-"));
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
      const commit = async (file: string, content: string) => {
        await writeFile(path.join(repository, file), content);
        git("add", file);
        git("commit", "--quiet", "-m", content);
        return git("rev-parse", "HEAD");
      };
      try {
        git("init", "--quiet", "-b", "main");
        git("config", "user.email", "test@example.invalid");
        git("config", "user.name", "Documentation gate test");
        await commit("docs.txt", "Published instructions");
        git("branch", "release/docs");
        await commit(
          "feature.txt",
          "Unreleased feature and next documentation",
        );
        if (context === "conflicting")
          await commit("docs.txt", "Instructions for the next API");
        const nextInstructions =
          context === "conflicting"
            ? "Corrected instructions for the next API"
            : "Corrected published instructions";
        const correction = await commit("docs.txt", nextInstructions);
        git("checkout", "--quiet", "release/docs");
        if (context === "conflicting") {
          expect(() => git("cherry-pick", "--quiet", correction)).toThrow();
          expect(git("diff", "--name-only", "--diff-filter=U")).toBe(
            "docs.txt",
          );
          await commit("docs.txt", "Corrected published instructions");
        } else git("cherry-pick", "--quiet", correction);
        const backport = git("rev-parse", "HEAD");
        expect(backport).not.toBe(correction);
        expect(() =>
          assertDocumentationSource({
            source: backport,
            releaseHead: backport,
          }),
        ).not.toThrow();
        git("checkout", "--quiet", "main");
        const next = await commit("feature.txt", "Next released feature");
        expect(() =>
          assertDocumentationSource({
            source: next,
            releaseHead: next,
          }),
        ).not.toThrow();
        git("checkout", "--quiet", "release/docs");
        if (context === "conflicting") {
          expect(() => git("merge", "--quiet", "--no-edit", "main")).toThrow();
          await commit("docs.txt", nextInstructions);
        } else git("merge", "--quiet", "--no-edit", "main");
        const merged = git("rev-parse", "HEAD");
        expect(await readFile(path.join(repository, "docs.txt"), "utf8")).toBe(
          nextInstructions,
        );
        expect(() =>
          assertDocumentationSource({
            source: merged,
            releaseHead: merged,
          }),
        ).not.toThrow();
        expect(() =>
          assertDocumentationSource({
            source: backport,
            releaseHead: merged,
          }),
        ).toThrow("release/docs tip");
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("stops promotion or maintenance when the deployed baseline changes during qualification", () => {
    expect(() =>
      assertDeploymentUnchanged(receipt.runId, receipt),
    ).not.toThrow();
    expect(() =>
      assertDeploymentUnchanged(receipt.runId, {
        ...receipt,
        runId: "124",
      }),
    ).toThrow("Deployed documentation changed during qualification");
    expect(() => assertDeploymentUnchanged(undefined, receipt)).toThrow();
  });

  it("requires a public original handoff for future promotion without changing a draft", () => {
    const captured = { release: { draft: true } };
    expect(() => assertPublicHandoff(captured)).toThrow(
      "public original release handoff",
    );
    expect(captured.release.draft).toBe(true);
    expect(() =>
      assertPublicHandoff({ release: { draft: false } }),
    ).not.toThrow();
  });
  it("holds production on CI and selects explicit promotion rather than latest main", () => {
    expect(
      selectPagesSource({ operation: "candidate", head: source }).source,
    ).toBe(source);
    expect(
      selectPagesSource({ operation: "maintain", baseline: receipt }).source,
    ).toBe(source);
    expect(
      selectPagesSource({
        operation: "promote",
        source,
        version: receipt.version,
        releaseSource,
      }).source,
    ).toBe(source);
    expect(() =>
      selectPagesSource({ operation: "promote", source: "main" }),
    ).toThrow();
  });

  it("bootstraps only the observed deployed npm documentation identity", () => {
    expect(
      resolveBaseline({
        deployment: {
          runId: "37920138687",
          sha: "47226ba0d4cb5ac8b018829e987376deaee6ea09",
        },
        receipt: undefined,
      }),
    ).toEqual({
      schemaVersion: 1,
      source: "47226ba0d4cb5ac8b018829e987376deaee6ea09",
      runId: "37920138687",
      version: "0.1.0-alpha.0",
      releaseSource: "2d9cade6cc5b517d1ee4189e3a8d6e636cacde90",
    });
    expect(() =>
      resolveBaseline({
        deployment: {
          runId: "37448450012",
          sha: "2d9cade6cc5b517d1ee4189e3a8d6e636cacde90",
        },
        receipt: undefined,
      }),
    ).toThrow();
    expect(() =>
      resolveBaseline({
        deployment: { runId: "124", sha: source },
        receipt: undefined,
      }),
    ).toThrow();
    expect(() =>
      resolveBaseline({ deployment: { runId: "124", sha: source }, receipt }),
    ).toThrow();
    expect(
      resolveBaseline({
        deployment: { runId: "123", sha: releaseSource },
        receipt,
      }),
    ).toEqual(receipt);
  });

  it("allows README corrections without republishing immutable runtime artifacts", () => {
    const released = {
      manifest: {
        name: "@sefaria/api-client",
        version: receipt.version,
        exports: { ".": "./dist/index.js" },
      },
      files: new Map([
        ["dist/index.js", Buffer.from("export const ready=true;")],
        ["README.md", Buffer.from("Original guide")],
        ["LICENSE", Buffer.from("MIT")],
      ]),
    };
    const candidate = {
      manifest: { ...released.manifest, description: "Improved guide" },
      files: new Map(released.files),
    };
    candidate.files.set(
      "README.md",
      Buffer.from("Corrected npm launch instructions"),
    );
    expect(() => assertRuntimeArtifacts(released, candidate)).not.toThrow();
    candidate.files.set(
      "dist/index.js",
      Buffer.from("export const ready=false;"),
    );
    expect(() => assertRuntimeArtifacts(released, candidate)).toThrow();
    candidate.files.set("dist/index.js", released.files.get("dist/index.js")!);
    candidate.manifest.exports = { ".": "./dist/other.js" };
    expect(() => assertRuntimeArtifacts(released, candidate)).toThrow();
  });

  it.each([
    "bin",
    "scripts",
    "os",
    "cpu",
    "libc",
    "bundledDependencies",
    "futureRuntimePolicy",
  ])(
    "rejects a changed %s manifest contract even when module bytes match",
    (key) => {
      const released = {
        manifest: { name: "@sefaria/api-client", version: receipt.version },
        files: new Map([
          ["dist/index.js", Buffer.from("export const ready=true;")],
        ]),
      };
      expect(() =>
        assertRuntimeArtifacts(released, {
          ...released,
          manifest: { ...released.manifest, [key]: "changed" },
        }),
      ).toThrow(`Candidate runtime manifest differs: ${key}.`);
    },
  );

  it.each(["capture", "npm", "cdn", "artifacts", "site"])(
    "does not admit a receipt when %s qualification fails",
    async (stage) => {
      const calls: string[] = [];
      const stages = Object.fromEntries(
        ["capture", "npm", "cdn", "artifacts", "site"].map((name) => [
          name,
          vi.fn(async () => {
            calls.push(name);
            if (name === stage) throw new Error(`${name} failed`);
          }),
        ]),
      );
      await expect(qualifyPromotion(receipt, stages)).rejects.toThrow(
        `${stage} failed`,
      );
      expect(calls.at(-1)).toBe(stage);
    },
  );

  it("admits only a fully qualified candidate", async () => {
    const calls: string[] = [];
    const stages = Object.fromEntries(
      ["capture", "npm", "cdn", "artifacts", "site"].map((name) => [
        name,
        async () => {
          calls.push(name);
        },
      ]),
    );
    await expect(qualifyPromotion(receipt, stages)).resolves.toEqual(receipt);
    expect(calls).toEqual(["capture", "npm", "cdn", "artifacts", "site"]);
  });

  it("preserves the baseline receipt when partial publication prevents promotion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pages-baseline-"));
    try {
      const file = path.join(directory, "documentation-release.json");
      const bytes = JSON.stringify(receipt);
      await writeFile(file, bytes);
      await expect(
        qualifyPromotion(
          { ...receipt, source: releaseSource },
          {
            capture: async () => {},
            npm: async () => {
              throw new Error("Only two packages are public.");
            },
          },
        ),
      ).rejects.toThrow("Only two packages");
      expect(await readFile(file, "utf8")).toBe(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads maintenance state from the successful provider deployment and rejects unavailable or stale public state", async () => {
    const api = {
      repos: {
        listDeployments: vi.fn(async () => ({
          data: [{ id: 1, sha: source }],
        })),
        listDeploymentStatuses: vi.fn(async () => ({
          data: [
            {
              state: "success",
              log_url:
                "https://github.com/Sefaria/sefaria-frontend-toolkit/actions/runs/123/job/456",
            },
          ],
        })),
      },
    };
    await expect(
      readBaseline(api, {
        fetch: async () => new Response(JSON.stringify(receipt)),
      }),
    ).resolves.toEqual(receipt);
    for (const fetch of [
      async () => new Response("", { status: 404 }),
      async () => new Response("", { status: 403 }),
      async () => new Response(JSON.stringify({ ...receipt, runId: "124" })),
      async () => {
        throw new TypeError("Network unavailable");
      },
    ])
      await expect(readBaseline(api, { fetch })).rejects.toThrow();
  });

  it("binds raw snippets, Vue import maps and Markdown before Vite hashes the assets", async () => {
    const plugin = siteModuleUrlsPlugin({
      version: receipt.version,
      basePath: "/",
      candidate: false,
    });
    expect(plugin.enforce).toBe("post");
    const input = Object.keys(moduleUrls(receipt.version)).join("\n");
    const transformed = plugin.transform(input, "snippet.html?raw");
    expect(transformed).toBe(
      Object.values(moduleUrls(receipt.version)).join("\n"),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "pages-modules-"));
    try {
      await writeFile(path.join(directory, "index.html"), input);
      await expect(
        assertSiteModules(directory, receipt.version, "/"),
      ).rejects.toThrow("Unbound legacy");
      await writeFile(path.join(directory, "index.html"), transformed);
      await expect(
        assertSiteModules(directory, receipt.version, "/"),
      ).resolves.toBeUndefined();
      expect(
        siteModuleUrlsPlugin({
          candidate: true,
          version: "",
          basePath: "/toolkit/",
        }).transform(input, "Theme.vue"),
      ).toContain("/toolkit/cdn/local/sefaria-elements.js");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds every actual npm-backed snippet to the candidate while preserving the verified release version", async () => {
    const directory = new URL("../examples/site-snippets/", import.meta.url);
    const candidate = siteModuleUrlsPlugin({
      version: "",
      candidate: true,
      basePath: "/toolkit/",
      documentedVersion: receipt.version,
    });
    const production = siteModuleUrlsPlugin({
      version: receipt.version,
      candidate: false,
      basePath: "/toolkit/",
      documentedVersion: receipt.version,
    });
    let count = 0;
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".html")) continue;
      const raw = await readFile(new URL(file, directory), "utf8");
      if (!raw.includes("sefaria-elements.js")) continue;
      expect(candidate.transform(raw, `${file}?raw`), file).toContain(
        'src="/toolkit/cdn/local/sefaria-elements.js"',
      );
      expect(production.transform(raw, `${file}?raw`), file).toBe(raw);
      count += 1;
    }
    expect(count).toBe(20);
  });
});
