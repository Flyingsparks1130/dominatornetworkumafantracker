async function downloadChronogenesisCsv(browser, club) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Give Cloudflare / app boot time.
    await page.waitForTimeout(5000);
    await dismissBlockingUi(page);

    async function waitForChronogenesisClubContent(page, clubId) {
  const candidates = [
    page.locator('text=/Member Cumulative Fan Count/i').first(),
    page.locator('text=/Show active members only/i').first(),
    page.locator('text=/Rank\\s+\\d+/i').first(),
    page.locator('[title="Export as .csv"]').first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 15000 });
      console.log(`Club content ready for ${clubId}`);
      return;
    } catch {}
  }

  throw new Error(`Chronogenesis content did not become visible for ${clubId}`);
}

    // Wait for actual club-page content, not just the site shell.
    // Based on your screenshot, these are good indicators the page is really loaded.
    const pageReadyCandidates = [
      page.locator('text=/Member Cumulative Fan Count/i').first(),
      page.locator('text=/Show active members only/i').first(),
      page.locator('text=/Rank\\s+\\d+/i').first(),
      page.locator('text=/2026-\\d\\d/i').first(),
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

    const exportCandidates = [
      page.locator('[title="Export as .csv"]').first(),
      page.locator('[aria-label="Export as .csv"]').first(),
      page.getByTitle("Export as .csv").first(),
      page.locator('[data-title="Export as .csv"]').first(),
      page.locator('svg[title="Export as .csv"]').first(),
    ];

    let exportLocator = null;

    for (const locator of exportCandidates) {
      try {
        if (await locator.count()) {
          exportLocator = locator;
          break;
        }
      } catch {}
    }

    if (!exportLocator) {
      throw new Error(`Export button not found for ${club.id}`);
    }

    await exportLocator.scrollIntoViewIfNeeded().catch(() => {});
    await exportLocator.hover({ timeout: 3000 }).catch(() => {});

    // Important: only start waiting for download once we know we can click.
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
