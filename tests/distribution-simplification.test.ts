import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as vite from "vite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildScriptSource,
  SCRIPT_ENTRIES,
} from "../scripts/build-script-source.mjs";

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof vite>();
  return { ...actual, build: vi.fn(actual.build) };
});
const { build } = vite;

describe("packaged browser build handoff", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sefaria-browser-handoff-"));
  }, 120_000);

  beforeEach(() => {
    vi.mocked(build).mockClear();
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses exact packaged bytes without invoking the bundler again", async () => {
    const destination = path.join(directory, "release");
    await buildScriptSource({ destination });
    expect(build).not.toHaveBeenCalled();
    for (const [entry, relative] of Object.entries(SCRIPT_ENTRIES)) {
      expect(await readFile(path.join(destination, entry))).toEqual(
        await readFile(
          path.join("packages", path.dirname(relative), "browser", entry),
        ),
      );
    }
  }, 120_000);

  it("fails on missing evidence rather than rebuilding browser modules", async () => {
    await expect(
      buildScriptSource({
        destination: path.join(directory, "missing"),
        browserBuildManifest: path.join(directory, "missing.json"),
      }),
    ).rejects.toThrow("missing.json");
    expect(build).not.toHaveBeenCalled();
  }, 120_000);

  it.each([
    "scripts/build-script-source.mjs",
    "packages/client/dist/index.js",
    "packages/client/dist/browser/sefaria-api-client.js",
    "packages/client/dist/browser/THIRD-PARTY-NOTICES.txt",
  ])("fails on a stale %s fingerprint without rebuilding", async (input) => {
    const source = await readFile(
      path.join(".artifacts", "package-browser-build.json"),
      "utf8",
    );
    const manifest = path.join(directory, "stale.json");
    const evidence: { inputs: Record<string, string> } = JSON.parse(source);
    expect(evidence.inputs).toHaveProperty(input);
    evidence.inputs[input] = "0".repeat(64);
    await writeFile(manifest, JSON.stringify(evidence));
    await expect(
      buildScriptSource({
        destination: path.join(directory, "stale"),
        browserBuildManifest: manifest,
      }),
    ).rejects.toThrow(input);
    expect(build).not.toHaveBeenCalled();
  });

  type Evidence = {
    schemaVersion: number;
    inputs: Record<string, string>;
    dependencies: Array<{ name: string; directory: string }>;
  };
  it.each<{
    name: string;
    error: string;
    mutate: (evidence: Evidence) => void;
  }>([
    {
      name: "missing license fingerprint",
      error: "Incomplete packaged browser build",
      mutate: (evidence) => {
        delete evidence.inputs.LICENSE;
      },
    },
    {
      name: "escaping input path",
      error: "Expected a repository-relative path",
      mutate: (evidence) => {
        evidence.inputs["../outside.txt"] = "0".repeat(64);
      },
    },
    {
      name: "stale dependency identity",
      error: "Stale dependency identity",
      mutate: (evidence) => {
        evidence.dependencies[0].name = "@invalid/identity";
      },
    },
    {
      name: "escaping dependency directory",
      error: "Expected a repository-relative path",
      mutate: (evidence) => {
        evidence.dependencies[0].directory = "../outside";
      },
    },
  ])("rejects $name before assembly", async ({ error, mutate }) => {
    const original = await readFile(
      path.join(".artifacts", "package-browser-build.json"),
      "utf8",
    );
    const filename = path.join(directory, "invalid.json");
    const evidence: Evidence = JSON.parse(original);
    mutate(evidence);
    await writeFile(filename, JSON.stringify(evidence));
    await expect(
      buildScriptSource({
        destination: path.join(directory, "invalid"),
        browserBuildManifest: filename,
      }),
    ).rejects.toThrow(error);
    expect(build).not.toHaveBeenCalled();
  });
});

describe("shared distribution workflows", () => {
  it("keeps ordinary CI validation-only while retaining browser evidence", async () => {
    for (const filename of ["ci.yml"]) {
      const source = await readFile(
        path.join(".github", "workflows", filename),
        "utf8",
      );
      expect(source).toContain(
        "uses: ./.github/workflows/validate-toolkit.yml",
      );
      expect(source).not.toContain("publish-packages.yml");
      expect(source).not.toContain("pnpm publish .artifacts/publish/");
      expect(source).not.toContain("pnpm check");
    }
  });
});
