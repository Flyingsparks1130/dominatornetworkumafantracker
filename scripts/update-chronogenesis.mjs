async function downloadChronogenesisCsv(browser, club) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);
    await dismissBlockingUi(page);

    const exportLocator = page
      .locator('div.save-button.expanded[title="Export as .csv"]')
      .first();

    await exportLocator.waitFor({ state: "visible", timeout: 15000 });

    const pageReadyCandidates = [
      page.locator('text=/Member Cumulative Fan Count/i').first(),
      page.locator('text=/Show active members only/i').first(),
      exportLocator,
      page.locator('select#month').first(),
    ];

    let pageReady = false;
    for (const locator of pageReadyCandidates) {
      try {
        await locator.waitFor({ state: "visible", timeout: 15000 });
        pageReady = true;
        break;
      } catch {}
    }

    await logInteractiveElements(page, club.id);

    if (!pageReady) {
      throw new Error(
        `Chronogenesis club content did not finish loading for ${club.id}. ` +
        `Likely blocked by Cloudflare or delayed app rendering.`
      );
    }

    if (!(await exportLocator.count())) {
      throw new Error(`Export button not found for ${club.id}`);
    }

    await exportLocator.scrollIntoViewIfNeeded().catch(() => {});
    await exportLocator.hover({ timeout: 3000 }).catch(() => {});

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    await exportLocator.click({ timeout: 5000, force: true });
    console.log(`Clicked export icon for ${club.id}`);

    const download = await downloadPromise;
    const tempPath = await download.path();

    if (!tempPath) {
      throw new Error(`Download path missing for ${club.id}`);
    }

    return await fs.readFile(tempPath, "utf8");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
