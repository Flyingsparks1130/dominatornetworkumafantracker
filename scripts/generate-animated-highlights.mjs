import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), "..");
const outputFlagIndex = process.argv.indexOf("--output");
const outputDirectory = path.resolve(
  outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]
    ? process.argv[outputFlagIndex + 1]
    : path.join(repositoryRoot, "generated", "daily-highlights"),
);
const requestedClubId = process.argv.includes("--club")
  ? process.argv[process.argv.indexOf("--club") + 1]
  : null;

const clubs = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, "scripts", "chronogenesis.clubs.config.json"), "utf8"),
).filter((club) => !requestedClubId || club.id === requestedClubId);

if (!clubs.length) throw new Error(`No configured club matched ${requestedClubId || "the request"}.`);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function safeFilename(value) {
  return String(value || "club")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "club";
}

function createStaticServer() {
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      const candidatePath = path.resolve(repositoryRoot, relativePath);
      if (!candidatePath.startsWith(`${repositoryRoot}${path.sep}`) && candidatePath !== repositoryRoot) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const stat = await fs.stat(candidatePath);
      const filePath = stat.isDirectory() ? path.join(candidatePath, "index.html") : candidatePath;
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(error?.code === "ENOENT" ? "Not found" : "Server error");
    }
  });
}

await fs.mkdir(outputDirectory, { recursive: true });
const server = createStaticServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];

try {
  for (const club of clubs) {
    let completed = false;
    for (let attempt = 1; attempt <= 2 && !completed; attempt += 1) {
      const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
      try {
        console.log(`Generating ${club.name} (${club.id}) insight story, attempt ${attempt}…`);
        await page.goto(`${origin}/club.html?id=${encodeURIComponent(club.id)}&animationBuild=1`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const buttonName = "🎞️ Build Hosted Animated Insight Story";
        const button = page.getByRole("button", { name: buttonName });
        await button.waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForFunction(
          (expectedName) => {
            const candidate = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === expectedName);
            return candidate && !candidate.disabled;
          },
          buttonName,
          { timeout: 90_000 },
        );
        const downloadPromise = page.waitForEvent("download", { timeout: 300_000 });
        await button.click();
        const download = await downloadPromise;
        const destination = path.join(outputDirectory, `${safeFilename(club.name)}-daily-highlight.gif`);
        await download.saveAs(destination);
        const { size } = await fs.stat(destination);
        if (size < 100_000) throw new Error(`Generated file was unexpectedly small (${size} bytes).`);
        console.log(`Saved ${destination} (${(size / 1_000_000).toFixed(2)} MB).`);
        completed = true;
      } catch (error) {
        console.error(`${club.name} insight story attempt ${attempt} failed:`, error?.message || error);
        if (attempt === 2) failures.push(`${club.name}: ${error?.message || error}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  throw new Error(`Animated highlight generation failed:\n${failures.join("\n")}`);
}

console.log(`Generated ${clubs.length} animated insight stor${clubs.length === 1 ? "y" : "ies"}.`);
