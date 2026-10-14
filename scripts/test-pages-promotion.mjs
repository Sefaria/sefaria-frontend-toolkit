import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

import { listFiles } from "./package-publication.mjs";
import { packageBrowserUrls } from "./site-module-urls.mjs";
import { startSitePreview } from "./site-preview-server.mjs";
import { createFixtureResponse } from "./site-fixtures.mjs";

export async function findPromotionRoutes(directory) {
  const routes = {};
  for (const file of await listFiles(directory)) {
    if (!file.endsWith(".html")) continue;
    const html = await readFile(path.join(directory, file), "utf8");
    for (const [kind, marker] of [
      ["editor", 'class="live-editor"'],
      ["runner", "code-language-toggle__run"],
    ])
      if (!routes[kind] && html.includes(marker)) routes[kind] = file;
    if (routes.editor && routes.runner) return routes;
  }
  throw new Error(
    "Selected documentation has no runnable editor or module runner.",
  );
}

export async function activatePromotionEditor(page) {
  const editor = page.locator(".live-editor").first();
  await editor.scrollIntoViewIfNeeded();
  await editor.locator("iframe").evaluate((element) => {
    if (element.getAttribute("sandbox") !== "allow-scripts")
      throw new Error("Selected editor is not an opaque scripts-only sandbox.");
  });
  // Mermaid can shift the editor offscreen after the initial scroll, before its
  // IntersectionObserver sets srcdoc. Keep it in view until lazy activation;
  // scrolling alone does not prove that the iframe has started.
  await page.waitForFunction(() => {
    const frame = globalThis.document.querySelector(".live-editor__frame");
    if (!frame) return false;
    if (frame.hasAttribute("srcdoc")) return true;
    frame.scrollIntoView({ block: "center", behavior: "instant" });
    return false;
  });
  await page
    .frameLocator(".live-editor__frame")
    .first()
    .locator("script[type=module]")
    .first()
    .waitFor({ state: "attached" });
  return editor;
}

export async function waitForPromotionRuntime(frame) {
  // Playwright defaults to requestAnimationFrame polling, which can stop in an
  // offscreen iframe even after the module registers its custom elements.
  // Poll on a timer instead; registration is still required within the existing
  // timeout. This is not a fixed sleep or a retry of the module request.
  await frame.waitForFunction(
    () => globalThis.customElements.get("sefaria-text-segment") !== undefined,
    null,
    { polling: 100 },
  );
}

export async function testPromotionSite({ root, version, basePath }) {
  const routes = await findPromotionRoutes(path.join(root, "dist", "site"));
  const urls = packageBrowserUrls(version, false);
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../tests/site-fixtures/micah-6-8-2026-09-28.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).payload;
  const server = await startSitePreview({ root, siteBasePath: basePath });
  try {
    await server.waitUntilReady();
    for (const engine of [chromium, firefox, webkit]) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const modules = new Set();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (Object.values(urls).includes(url.href)) {
            modules.add(url.href);
            await route.continue();
          } else if (
            url.origin === server.origin ||
            ["about:", "blob:", "data:"].includes(url.protocol)
          )
            await route.continue();
          else if (
            url.origin === "https://www.sefaria.org" &&
            url.pathname.startsWith("/api/v3/texts/")
          )
            await route.fulfill({
              json: createFixtureResponse(
                url.href,
                "text-fixture",
                fixture,
                [],
              ),
            });
          else await route.abort("blockedbyclient");
        });
        await page.goto(`${server.siteUrl}${routes.editor}`);
        const editor = await activatePromotionEditor(page);
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector(".live-editor__frame")?.style
              .height,
        );
        const child = await (
          await editor.locator("iframe").elementHandle()
        ).contentFrame();
        await waitForPromotionRuntime(child);
        assert(
          modules.has(urls["@sefaria/web-components"]),
          "Selected editor did not request the qualified elements URL.",
        );
        await page.goto(`${server.siteUrl}${routes.runner}`);
        const runner = page
          .locator(".code-language-toggle")
          .filter({
            has: page.getByRole("button", { name: "Run", exact: true }),
          })
          .first();
        await runner.getByRole("button", { name: "Run", exact: true }).click();
        await runner
          .locator('.code-language-toggle__console[data-state="done"]')
          .waitFor();
        assert.equal(
          await runner.locator("pre.is-error").count(),
          0,
          await runner.locator(".code-language-toggle__console").textContent(),
        );
        assert(
          [...modules].some(
            (url) =>
              url === urls["@sefaria/api-client"] ||
              url === urls["@sefaria/text-transform"],
          ),
          "Selected runner did not request a qualified package URL.",
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
}
