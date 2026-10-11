import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findPromotionRoutes } from "../scripts/test-pages-promotion.mjs";

describe("selected-tree production acceptance", () => {
  it("discovers selected routes without main's page names, text, redirects or recommendation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "pages-selected-routes-"),
    );
    try {
      await mkdir(path.join(directory, "current"));
      await writeFile(
        path.join(directory, "current", "renamed-editor.html"),
        '<section class="live-editor">Current release wording</section>',
      );
      await writeFile(
        path.join(directory, "current", "renamed-tools.html"),
        '<button class="code-language-toggle__run">Run</button>',
      );
      expect(await findPromotionRoutes(directory)).toEqual({
        editor: "current/renamed-editor.html",
        runner: "current/renamed-tools.html",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
