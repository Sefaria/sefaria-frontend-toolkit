import { expect, test } from "vitest";

import { selectFastCheckCommands } from "../scripts/site-check-selection.mjs";

const commands = (files: readonly string[] | undefined) =>
  selectFastCheckCommands(files).map((args) => args.join(" "));

test("runs prose and structural checks without a site build for contributor docs", () => {
  expect(commands(["docs/development.md"])).toEqual([
    "format:check",
    "lint",
    "test tests/documentation-site.test.ts",
    "prose:check",
  ]);
});

test("builds the site for public docs and shared VitePress configuration", () => {
  for (const file of [
    "docs/use-components/show-an-attributed-passage.md",
    "docs/.vitepress/config.ts",
  ]) {
    expect(commands([file])).toContain("build:site");
    expect(commands([file])).toContain("test tests/documentation-site.test.ts");
  }
});

test("builds the site for changed or deleted public pages", () => {
  for (const file of [
    "docs/use-components/new-page.md",
    "docs/use-components/removed-page.md",
  ]) {
    expect(commands([file])).toContain("build:site");
  }
});

test("builds the site for changed and untracked runnable examples", () => {
  expect(commands(["examples/reader/src/app.ts"])).toContain("build:site");
  expect(commands(["examples/newly-added/index.html"])).toContain("build:site");
});

test("checks generated references when a reference input changes", () => {
  for (const file of [
    "docs/reference/components.md",
    "scripts/reference/components.ts",
    "packages/web-components/src/source-card-element.ts",
    "tests/reference-docs/tsconfig.json",
    "examples/site-snippets/text-segment.html",
    "examples/site-snippets/ai-assistant-prompt.md",
    "docs/README.md",
  ]) {
    expect(commands([file])).toContain("reference:check");
  }
  expect(
    commands(["examples/site-snippets/local-reader-loader.ts"]),
  ).not.toContain("reference:check");
});

test("does not run the site build for the generated theme README", () => {
  expect(commands(["docs/.vitepress/theme/README.md"])).not.toContain(
    "build:site",
  );
  expect(commands(["docs/.vitepress/theme/README.md"])).toContain(
    "reference:check",
  );
});

test("uses the full fast subset when all files are requested or Git selection fails", () => {
  const all = [
    "format:check",
    "lint",
    "build:site",
    "test tests/documentation-site.test.ts",
    "check:api-docs",
    "reference:check",
    "prose:check",
  ];

  expect(commands(undefined)).toEqual(all);
});

test("runs no checks when Git reports no changed files", () => {
  expect(commands([])).toEqual([]);
});
