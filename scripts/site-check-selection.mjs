const contributorOnlyDocRules = [
  { pattern: "README.md", matches: (file) => file === "README.md" },
  { pattern: "archive/**", matches: (file) => file.startsWith("archive/") },
  { pattern: "design.md", matches: (file) => file === "design.md" },
  { pattern: "development.md", matches: (file) => file === "development.md" },
  { pattern: "evidence.md", matches: (file) => file === "evidence.md" },
  { pattern: "handoff.md", matches: (file) => file === "handoff.md" },
  {
    pattern: "release-administration.md",
    matches: (file) => file === "release-administration.md",
  },
  { pattern: "review.md", matches: (file) => file === "review.md" },
  { pattern: "specs/**", matches: (file) => file.startsWith("specs/") },
  {
    pattern: ".vitepress/theme/README.md",
    matches: (file) => file === ".vitepress/theme/README.md",
  },
];

export const CONTRIBUTOR_ONLY_DOC_PATTERNS = contributorOnlyDocRules.map(
  ({ pattern }) => pattern,
);

const referenceInputFiles = new Set([
  "README.md",
  "docs/README.md",
  "docs/index.md",
  "docs/help/install-and-status.md",
  "docs/use-components/start-here.md",
  "docs/use-components/use-with-a-framework.md",
  "docs/data-and-text-tools/start-here.md",
  "docs/.vitepress/theme/README.md",
  "examples/site-snippets/ai-assistant-prompt.md",
  "scripts/npm-documentation-release.json",
  "pnpm-lock.yaml",
]);

const referenceInputDirectories = [
  "docs/reference/",
  "scripts/reference/",
  "packages/",
  "tests/reference-docs/",
];

/** Returns whether a repository path is excluded from VitePress source pages. */
export function isContributorOnlyDoc(file) {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized.startsWith("docs/")) return false;
  const relative = normalized.slice("docs/".length);
  return contributorOnlyDocRules.some(({ matches }) => matches(relative));
}

/** Returns the fast-check commands selected for changed paths, or all paths. */
export function selectFastCheckCommands(files) {
  const selectAll = files === undefined;
  const changedFiles = files ?? [];
  const commands = [];

  if (selectAll || changedFiles.length > 0) {
    commands.push(["format:check"], ["lint"]);
  }

  const hasDocsOrExamples =
    selectAll ||
    changedFiles.some(
      (file) => file.startsWith("docs/") || file.startsWith("examples/"),
    );
  if (hasDocsOrExamples) {
    const requiresSiteBuild =
      selectAll ||
      changedFiles.some(
        (file) =>
          file.startsWith("examples/") ||
          (file.startsWith("docs/") && !isContributorOnlyDoc(file)),
      );
    if (requiresSiteBuild) commands.push(["build:site"]);
    commands.push(["test", "tests/documentation-site.test.ts"]);
  }

  if (
    selectAll ||
    changedFiles.some((file) =>
      /^(docs\/reference|packages\/|scripts\/check-api-docs\.mjs|pnpm-lock\.yaml)/u.test(
        file,
      ),
    )
  ) {
    commands.push(["check:api-docs"]);
  }

  if (
    selectAll ||
    changedFiles.some(
      (file) =>
        referenceInputFiles.has(file) ||
        (file.startsWith("examples/site-snippets/") &&
          file.endsWith(".html")) ||
        referenceInputDirectories.some((directory) =>
          file.startsWith(directory),
        ),
    )
  ) {
    commands.push(["reference:check"]);
  }

  if (
    selectAll ||
    changedFiles.some(
      (file) =>
        file.startsWith("docs/") ||
        file === "README.md" ||
        /^packages\/.*README\.md$/u.test(file),
    )
  ) {
    commands.push(["prose:check"]);
  }

  return commands;
}
