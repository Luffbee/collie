import { expect, test, type Page } from "@playwright/test";

import { fixtureAgents } from "@/test/handlers";
import { fixtureMathFile, fixtureMathTranscript } from "@/test/math-fixtures";

import { installApiStub } from "./fixtures/api";
import { serveWithShellCsp } from "./fixtures/csp";

const PANE = encodeURIComponent(fixtureAgents[0]!.paneId);
const FILE = `/pane/${PANE}/changes/files?path=README.md`;

async function installMathStub(page: Page) {
  await installApiStub(page);
  await page.route("**/api/**/files?path=README.md", (route) => route.fulfill({ json: fixtureMathFile() }));
  await page.route("**/api/**/history**", (route) => route.fulfill({ json: {
    paneId: fixtureAgents[0]!.paneId,
    available: true,
    entries: fixtureMathTranscript,
    hasMore: false,
    total: fixtureMathTranscript.length,
    fileTruncated: false,
  } }));
  await serveWithShellCsp(page);
}

test.describe("equations under the bridge CSP", () => {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => installMathStub(page));

  for (const theme of ["light", "dark"]) {
    test(`equations fit the phone and load local fonts in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem("collie:theme:v1", value), theme);
      const failedFonts: string[] = [];
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "font") failedFonts.push(request.url());
      });
      await page.goto(FILE);
      const equations = page.getByRole("math");
      await expect(equations).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => [...document.fonts]
        .filter((font) => font.family.startsWith("KaTeX_") && font.status === "loaded").map((font) => font.family));
      expect(fonts).toContain("KaTeX_Main");
      expect(failedFonts).toEqual([]);

      const widths = await equations.evaluateAll((nodes) => nodes.map((node) => {
        const box = node.closest<HTMLElement>('[data-slot="math"]')!;
        return { width: box.clientWidth, scroll: box.scrollWidth, viewport: window.innerWidth };
      }));
      for (const box of widths) expect(box.width).toBeLessThanOrEqual(box.viewport);
      // Both the wide display and wide inline equation pan inside themselves.
      for (const index of [3, 4]) {
        expect(widths[index]!.scroll).toBeGreaterThan(widths[index]!.width);
        const panned = await equations.nth(index).evaluate((node) => {
          const box = node.closest<HTMLElement>('[data-slot="math"]')!;
          box.scrollLeft = box.scrollWidth;
          return box.scrollLeft;
        });
        expect(panned).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("equations.png"), fullPage: true });
    });
  }

  test("the same equations render in History", async ({ page }) => {
    await page.goto(`/pane/${PANE}/history`);
    await expect(page.getByRole("math")).toHaveCount(5);
  });
});
