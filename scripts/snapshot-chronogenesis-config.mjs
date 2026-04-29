import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const INDEX_FILE = "index.html";
const CONFIG_DIR = path.join("data", "chronogenesis", "archive", "config");
const TIME_ZONE = "Asia/Bangkok";

fs.mkdirSync(CONFIG_DIR, { recursive: true });

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getBangkokMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);

  return `${year}-${pad2(month)}`;
}

function extractConstExpression(source, constName) {
  const marker = `const ${constName}`;
  const start = source.indexOf(marker);

  if (start < 0) {
    throw new Error(`Could not find ${marker} in ${INDEX_FILE}`);
  }

  const equalsIndex = source.indexOf("=", start);
  if (equalsIndex < 0) {
    throw new Error(`Could not find assignment for ${constName}`);
  }

  let cursor = equalsIndex + 1;
  let quote = null;
  let depth = 0;

  for (; cursor < source.length; cursor++) {
    const char = source[cursor];
    const previous = source[cursor - 1];

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "[" || char === "{" || char === "(") depth++;
    if (char === "]" || char === "}" || char === ")") depth--;

    if (char === ";" && depth === 0) {
      return source.slice(equalsIndex + 1, cursor).trim();
    }
  }

  throw new Error(`Could not parse expression for ${constName}`);
}

function evaluateExpression(expression, constName) {
  const script = new vm.Script(`(${expression})`, {
    filename: `${INDEX_FILE}:${constName}`,
  });

  return script.runInNewContext(Object.freeze({}));
}

function buildClubConfigById(clubs) {
  return Object.fromEntries(
    clubs.map((club) => [String(club.id), { ...club, id: String(club.id) }])
  );
}

function main() {
  const monthKey = process.argv[2] || getBangkokMonthKey();
  const indexSource = fs.readFileSync(INDEX_FILE, "utf8");

  const clubs = evaluateExpression(extractConstExpression(indexSource, "CLUBS"), "CLUBS")
    .map((club) => ({ ...club, id: String(club.id) }));

  const maxMembers = evaluateExpression(
    extractConstExpression(indexSource, "MAX_MEMBERS"),
    "MAX_MEMBERS"
  );

  const rankingConfig = evaluateExpression(
    extractConstExpression(indexSource, "RANKING_CONFIG"),
    "RANKING_CONFIG"
  );

  const rankIconPath = evaluateExpression(
    extractConstExpression(indexSource, "RANK_ICON_PATH"),
    "RANK_ICON_PATH"
  );

  const tierColors = evaluateExpression(
    extractConstExpression(indexSource, "TIER_COLORS"),
    "TIER_COLORS"
  );

  const snapshot = {
    schema: 1,
    source: INDEX_FILE,
    month: monthKey,
    createdAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    maxMembers,
    rankIconPath,
    clubs,
    clubConfigById: buildClubConfigById(clubs),
    rankingConfig,
    tierColors,
  };

  const outPath = path.join(CONFIG_DIR, `${monthKey}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");

  console.log(`Saved Chronogenesis config snapshot: ${outPath}`);
}

main();
