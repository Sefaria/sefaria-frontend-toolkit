import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { validateWorkflowPolicy as validate } from "../scripts/integration-policy.mjs";

const read = (name: string) =>
  readFileSync(path.resolve(".github", "workflows", name), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
const ci = read("ci.yml");
const validation = read("validate-toolkit.yml");
const release = read("release-npm.yml");
const policy = (name: string, source: string) =>
  validate({ "validate-toolkit.yml": validation, [name]: source });

describe("exact release and validation workflow contracts", () => {
  it("admits maintained workflows without resurrecting GitHub Packages", () => {
    for (const name of [
      "ci.yml",
      "release-npm.yml",
      "pages.yml",
      "script-retirement.yml",
      "copilot-setup-steps.yml",
      "openapi-drift.yml",
    ])
      expect(policy(name, read(name))).toEqual([]);
    for (const name of ["publish-packages.yml", "bootstrap-packages.yml"])
      expect(policy(name, "on:\n  workflow_dispatch:\njobs: {}")).not.toEqual(
        [],
      );
  });

  it("keeps shared Linux/Windows validation and fail-closed aggregation", () => {
    expect(Object.keys(YAML.parse(ci).jobs).sort()).toEqual([
      "check",
      "validation",
    ]);
    expect(YAML.parse(validation).jobs.validation.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["ubuntu-latest", "windows-latest"] },
    });
    expect(validate({ "ci.yml": ci }).join("\n")).toContain(
      "missing reusable workflow",
    );
    for (const candidate of [
      ci.replace('!= "success"', '!= "failure"'),
      ci.replace("if: ${{ always() }}", "if: true"),
      ci.replace("contents: read", "contents: write"),
      ci +
        "\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
    ])
      expect(policy("ci.yml", candidate).length).toBeGreaterThan(0);
    for (const candidate of [
      validation.replace("          - windows-latest", ""),
      validation.replace(
        "      - run: pnpm check",
        "      - if: false\n        run: pnpm check",
      ),
      validation.replace("fail-fast: false", "fail-fast: true"),
      validation.replace("pnpm setup:agent", "echo skipped"),
    ])
      expect(policy("validate-toolkit.yml", candidate).length).toBeGreaterThan(
        0,
      );
  });

  it("captures exact package assets before approval and never builds or packs in publication", () => {
    const jobs = YAML.parse(release).jobs;
    expect(jobs.publish.environment).toBe("npm-release");
    expect(jobs.publish.needs).toEqual(["guard", "draft"]);
    expect(jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    for (const name of ["draft", "finalize"])
      expect(jobs[name].permissions).toEqual({ contents: "write" });
    for (const name of ["prepare", "verify", "guard"])
      expect(JSON.stringify(jobs[name].permissions ?? {})).not.toMatch(
        /"write"/,
      );
    for (const name of ["publish", "verify", "finalize"]) {
      const steps = JSON.stringify(jobs[name].steps);
      expect(steps).not.toMatch(
        /pnpm build|npm pack|package:smoke|npm-release\.mjs prepare/,
      );
      expect(steps).toContain("captured-npm");
    }
    expect(jobs.finalize.if).toContain("needs.verify.result == 'success'");
    expect(jobs.draft.if).toContain("always()");
    expect(
      jobs.draft.steps.find(
        (step: { run?: string }) =>
          step.run === "node scripts/npm-release.mjs capture",
      ).if,
    ).toBe("${{ inputs.operation != 'prepare' }}");
    expect(jobs.capture).toBeUndefined();
    expect(jobs.prepare.strategy.matrix.os).toEqual([
      "ubuntu-latest",
      "windows-latest",
    ]);
    expect(release).not.toMatch(
      /secrets\.|NODE_AUTH_TOKEN|packages:|vars\.|registry-url/,
    );
    expect(release).not.toContain("npm-release.mjs guard");
    expect(release).not.toContain("actions: read");
  });

  it("disables workspace and npm install hooks in the OIDC publisher", () => {
    const workflow = YAML.parse(release);
    const steps = workflow.jobs.publish.steps;
    expect(steps.map((step: { run?: string }) => step.run)).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    expect(steps.map((step: { run?: string }) => step.run)).toContain(
      "npm install --global npm@11.5.2 --ignore-scripts",
    );
    for (const step of steps.filter((step: { run?: string }) =>
      /^(?:pnpm|npm) install\b/.test(step.run ?? ""),
    )) {
      const mutated = structuredClone(workflow);
      const index = steps.indexOf(step);
      mutated.jobs.publish.steps[index].run = step.run.replace(
        " --ignore-scripts",
        "",
      );
      expect(
        policy("release-npm.yml", YAML.stringify(mutated)).length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects every named main/manual/approval/permission/source/asset bypass", () => {
    for (const [before, after] of [
      ["workflow_dispatch:", "push:"],
      ["github.ref == 'refs/heads/main'", "true"],
      ["github.event_name == 'workflow_dispatch'", "true"],
      ["environment: npm-release", "environment: github-pages"],
      ["cancel-in-progress: false", "cancel-in-progress: true"],
      ["node-version: 22.14.0", "node-version: 22.12.0"],
      ["npm@11.5.2", "npm@10"],
      ["node scripts/npm-release.mjs assert-source", "echo unchecked"],
      ["node scripts/npm-release.mjs compare-platforms", "echo skipped"],
      [
        "needs.prepare.result == 'success'",
        "needs.prepare.result != 'failure'",
      ],
      ["needs.verify.result == 'success'", "true"],
      ["needs: [guard, draft]", "needs: guard"],
      ["name: captured-npm", "name: mutable-latest"],
      ["if-no-files-found: error", "if-no-files-found: warn"],
      [
        "contents: read\n      id-token: write",
        "contents: write\n      id-token: write",
      ],
      [
        "GITHUB_TOKEN: ${{ github.token }}",
        "GITHUB_TOKEN: ${{ secrets.NPM_TOKEN }}",
      ],
      [
        "node scripts/npm-release.mjs publish",
        "pnpm build && npm pack && npm publish",
      ],
    ]) {
      expect(release).toContain(before);
      expect(
        policy("release-npm.yml", release.replaceAll(before, after)).length,
      ).toBeGreaterThan(0);
    }
  });

  it("preserves Pages restoration and rejects changed maintenance gates", () => {
    const pages = read("pages.yml");
    expect(pages).toContain(
      "node ../control/scripts/script-source-release.mjs restore",
    );
    for (const candidate of [
      pages.replace(
        "node ../control/scripts/script-source-release.mjs restore",
        "echo skipped",
      ),
      pages.replace("conclusion == 'success'", "conclusion != 'failure'"),
      pages.replace(
        "ref: main",
        "ref: ${{ github.event.workflow_run.head_sha }}",
      ),
      pages.replace(
        "node ../control/scripts/pages-promotion.mjs qualify",
        "echo qualified",
      ),
      pages.replace("needs.resolve.outputs.operation != 'candidate'", "true"),
      pages.replace("ref: ${{ needs.resolve.outputs.source }}", "ref: main"),
    ])
      expect(policy("pages.yml", candidate).length).toBeGreaterThan(0);
    expect(
      policy(
        "script-retirement.yml",
        read("script-retirement.yml").replace(
          "if: ${{ github.ref == 'refs/heads/main' }}",
          "if: true",
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps main candidates separate from current-release correction deployment and pins sources", () => {
    const jobs = YAML.parse(read("pages.yml")).jobs;
    expect(jobs.deploy.if).toBe(
      "${{ needs.resolve.outputs.operation != 'candidate' }}",
    );
    expect(jobs.resolve.steps.at(-1).env.PAGES_OPERATION).toContain(
      "head_branch == 'release/docs' && 'promote' || 'candidate'",
    );
    expect(jobs.build.env.DEPLOYED_RUN_ID).toBe(
      "${{ needs.resolve.outputs.baselineRunId }}",
    );
    expect(jobs.resolve.outputs.baselineRunId).toBe(
      "${{ steps.select.outputs.baselineRunId }}",
    );
    const checkouts = jobs.build.steps.filter(
      (step: { uses?: string }) => step.uses === "actions/checkout@v4",
    );
    expect(
      checkouts.map((step: { with: { ref: string } }) => step.with.ref),
    ).toEqual([
      "${{ needs.resolve.outputs.controller }}",
      "${{ needs.resolve.outputs.source }}",
    ]);
    const steps = jobs.build.steps;
    const qualify = steps.findIndex((step: { run?: string }) =>
      step.run?.endsWith("pages-promotion.mjs qualify"),
    );
    const upload = steps.findIndex(
      (step: { uses?: string }) =>
        step.uses === "actions/upload-pages-artifact@v5",
    );
    expect(qualify).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(qualify);
    const releaseJobs = YAML.parse(release).jobs;
    expect(releaseJobs.guard.steps[0].with.ref).toBe("main");
    const history = releaseJobs.guard.steps.findIndex(
      (step: { run?: string }) =>
        step.run?.includes("npm-release.mjs assert-history"),
    );
    const sourceCheckout = releaseJobs.guard.steps.findIndex(
      (step: { with?: { ref?: string } }) =>
        step.with?.ref === "${{ inputs.source }}",
    );
    expect(history).toBeGreaterThan(0);
    expect(sourceCheckout).toBeGreaterThan(history);
    for (const name of ["draft", "publish", "verify", "finalize"])
      expect(
        releaseJobs[name].steps.find(
          (step: { uses?: string }) => step.uses === "actions/checkout@v4",
        )?.with?.ref,
      ).toBe("${{ needs.guard.outputs.controller }}");
    expect(YAML.parse(read("pages.yml")).concurrency.group).toContain(
      "pages-candidate-{0}",
    );
    expect(YAML.parse(ci).on).toEqual({
      pull_request: { branches: ["main", "release/docs"] },
      push: { branches: ["main", "release/docs"] },
    });

    expect(jobs.resolve.steps.at(-1).env.CURRENT_RELEASE_CORRECTION).toContain(
      "head_branch == 'release/docs'",
    );
    expect(
      jobs.build.steps.find((step: { run?: string }) =>
        step.run?.endsWith("pages-promotion.mjs receipt"),
      ).env.GITHUB_TOKEN,
    ).toBe("${{ github.token }}");
    expect(jobs.build.permissions.deployments).toBe("read");
    expect(jobs.build.steps).toContainEqual({
      run: "pnpm exec playwright install --with-deps chromium firefox webkit",
      "working-directory": "control",
    });
  });

  it("admits only authorized production triggers to the shared Pages concurrency group", () => {
    const expression = YAML.parse(read("pages.yml")).concurrency.group;
    const group = new Function(
      "github",
      "inputs",
      "format",
      `return ${expression.slice(3, -2)};`,
    );
    const github = {
      ref: "refs/heads/main",
      event_name: "workflow_run",
      repository: "Sefaria/sefaria-frontend-toolkit",
      run_id: "123",
      event: {
        workflow_run: {
          name: "CI",
          event: "push",
          conclusion: "success",
          head_branch: "release/docs",
          head_repository: {
            full_name: "Sefaria/sefaria-frontend-toolkit",
          },
        },
      },
    };
    const select = (event = github, operation = "promote") =>
      group(event, { operation }, (template: string, id: string) =>
        template.replace("{0}", id),
      );
    const run = github.event.workflow_run;
    const withRun = (changes: Partial<typeof run>) => ({
      ...github,
      event: { workflow_run: { ...run, ...changes } },
    });
    const candidate = `pages-candidate-${github.run_id}`;
    expect(select()).toBe("github-pages");
    expect(select({ ...github, event_name: "workflow_dispatch" })).toBe(
      "github-pages",
    );
    expect(
      select({
        ...github,
        ref: "refs/heads/feature",
        event_name: "workflow_dispatch",
      }),
    ).toBe(candidate);
    expect(
      select({ ...github, event_name: "workflow_dispatch" }, "candidate"),
    ).toBe(candidate);
    for (const changes of [
      { event: "pull_request" },
      { head_repository: { full_name: "fork/toolkit" } },
      { head_branch: "main" },
      { conclusion: "failure" },
    ])
      expect(select(withRun(changes))).toBe(candidate);
    expect(
      select(
        withRun({
          name: "Retire script version",
          event: "workflow_dispatch",
          head_branch: "main",
        }),
      ),
    ).toBe("github-pages");
    expect(select(withRun({ name: "Retire script version" }))).toBe(candidate);
  });

  it("keeps Copilot setup and OpenAPI drift capabilities narrowly scoped", () => {
    const setup = read("copilot-setup-steps.yml");
    expect(setup).not.toMatch(/contents: write|id-token|secrets\./);
    expect(
      policy(
        "copilot-setup-steps.yml",
        setup.replace("pnpm setup:agent", "pnpm publish"),
      ).length,
    ).toBeGreaterThan(0);
    const drift = read("openapi-drift.yml");
    for (const candidate of [
      drift.replace("issues: write", "pull-requests: write"),
      drift.replace("secrets.COPILOT_ASSIGN_TOKEN", "secrets.NPM_TOKEN"),
      drift.replace("pnpm openapi:drift --issue", "pnpm openapi:refresh"),
    ])
      expect(policy("openapi-drift.yml", candidate).length).toBeGreaterThan(0);
  });
});
