import { once } from "node:events";
import console from "node:console";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { expect, test, vi } from "vitest";

import { navigatePackageBrowserHost } from "../scripts/test-package-browser.mjs";

test("records an unfinished owned response without replacing the navigation failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "package-navigation-"));
  const host = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.flushHeaders();
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const request = once(host, "request");
    const response = page.waitForResponse(() => true);
    let originalError: unknown;
    const goto = page.goto.bind(page);
    vi.spyOn(page, "goto").mockImplementation(async (...args) => {
      try {
        return await goto(...args);
      } catch (error) {
        originalError = error;
        throw error;
      }
    });
    const navigation = navigatePackageBrowserHost({
      page,
      host,
      engineName: "chromium",
      diagnosticDirectory: directory,
    }).catch((error: unknown) => error);
    await request;
    await response;
    for (let index = 0; index < 40; index++) page.emit("domcontentloaded");
    await page.close();
    expect(await navigation).toBe(originalError);

    const report = JSON.parse(
      await readFile(
        path.join(directory, "package-browser-navigation-chromium.json"),
        "utf8",
      ),
    );
    expect(report.engine).toBe("chromium");
    expect(report.hostListening).toBe(true);
    expect(report.events).toContainEqual(
      expect.objectContaining({ kind: "browser-response", status: 200 }),
    );
    expect(
      report.events.map((event: { kind: string }) => event.kind),
    ).toContain("host-request");
    expect(
      report.events.map((event: { kind: string }) => event.kind),
    ).not.toContain("host-response-finish");
    expect(report.events.length).toBeLessThanOrEqual(32);
    expect(report.droppedEvents).toBeGreaterThan(0);
    expect(host.listenerCount("request")).toBe(1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("leaves successful navigation and the diagnostic directory untouched", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "package-navigation-"));
  const host = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><html><body></body></html>");
  });

  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await navigatePackageBrowserHost({
      page,
      host,
      engineName: "chromium",
      diagnosticDirectory: directory,
    });
    expect(await page.evaluate(() => document.readyState)).toBe("complete");
    expect(await readdir(directory)).toEqual([]);
    expect(host.listenerCount("request")).toBe(1);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports diagnostic write failure without replacing the original navigation error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "package-navigation-"));
  const blockedDirectory = path.join(directory, "not-a-directory");
  await writeFile(blockedDirectory, "");
  const host = createServer();
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const browser = await chromium.launch();
  const diagnosticError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  try {
    const page = await browser.newPage();
    const failure = new Error("Controlled navigation failure");
    vi.spyOn(page, "goto").mockRejectedValue(failure);
    await expect(
      navigatePackageBrowserHost({
        page,
        host,
        engineName: "chromium",
        diagnosticDirectory: blockedDirectory,
      }),
    ).rejects.toBe(failure);
    expect(diagnosticError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(host.listenerCount("request")).toBe(0);
  } finally {
    diagnosticError.mockRestore();
    await browser.close();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
