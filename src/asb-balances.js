/**
 * ASB Account Balances
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to the ASB balances page, then prints all visible accounts and
 * their balances.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to ASB FastNet Classic
 */
import { connectToChrome } from "./connect-browser.js";

const BALANCES_URL = "https://online.asb.co.nz/fnc/1/goto/balances?referrer=fnc";
const LOGIN_URL = "https://online.asb.co.nz/auth/";
const APP_URL_PATTERN = /online\.asb\.co\.nz\/fnc\//i;
const AUTH_URL_PATTERN = /online\.asb\.co\.nz\/auth\//i;
const MONEY_PATTERN =
  /\(?-?(?:NZD\s*)?\$?\d[\d,]*(?:\.\d{2})\)?/gi;
const ACCOUNT_ID_PATTERN =
  /\b\d{2,3}(?:[- ]\d{2,7}){1,4}\b|\b\d{6,}\b/;

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function parseCurrency(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const negative =
    (trimmed.includes("(") && trimmed.includes(")")) ||
    /\bOD\b/i.test(trimmed) ||
    /^-/.test(trimmed);
  const normalized = trimmed
    .replace(/[^0-9.-]/g, "");

  if (!normalized || normalized === "-" || normalized === ".") return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;

  return negative ? -Math.abs(parsed) : parsed;
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";

  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: "NZD",
  }).format(value);
}

function extractMoneyTexts(text) {
  return normalizeText(text).match(MONEY_PATTERN) ?? [];
}

function isMostlyLabel(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;

  return [
    "current balance",
    "available balance",
    "balance",
    "available",
    "credit limit",
    "overdraft",
    "account",
    "description",
    "type",
    "total",
  ].includes(normalized);
}

function pickName(parts) {
  return (
    parts.find((part) => {
      const normalized = normalizeText(part);
      return (
        normalized &&
        /[A-Za-z]/.test(normalized) &&
        !extractMoneyTexts(normalized).length &&
        !isMostlyLabel(normalized)
      );
    }) ?? ""
  );
}

function pickAccountIdentifier(parts) {
  const combined = parts.map(normalizeText).filter(Boolean).join(" ");
  return combined.match(ACCOUNT_ID_PATTERN)?.[0] ?? "";
}

function parseTableAccounts(tables) {
  const accounts = [];

  for (const table of tables) {
    const headings = table.headings.map((heading) => heading.toLowerCase());

    for (const row of table.rows) {
      const cells = row.map((cell) => normalizeText(cell)).filter(Boolean);
      if (!cells.length) continue;

      const cellInfo = cells.map((text, index) => ({
        text,
        heading: headings[index] ?? "",
        amounts: extractMoneyTexts(text),
      }));

      const moneyCells = cellInfo.filter((cell) => cell.amounts.length > 0);
      if (!moneyCells.length) continue;

      const descriptorParts = cellInfo
        .filter((cell) => !cell.amounts.length)
        .map((cell) => cell.text)
        .filter(Boolean);

      const name = pickName(descriptorParts);
      const accountNumber = pickAccountIdentifier(descriptorParts);
      if (!name && !accountNumber) continue;

      const currentByHeading = cellInfo.find(
        (cell) =>
          cell.amounts.length &&
          /(current|ledger|closing|balance)/.test(cell.heading) &&
          !/available/.test(cell.heading)
      );
      const availableByHeading = cellInfo.find(
        (cell) => cell.amounts.length && /available/.test(cell.heading)
      );

      const currentBalance =
        currentByHeading?.amounts.at(-1) ?? moneyCells.at(-1)?.amounts.at(-1) ?? "";
      const availableBalance =
        availableByHeading?.amounts.at(-1) ??
        (moneyCells.length > 1 ? moneyCells.at(-2)?.amounts.at(-1) ?? "" : "");

      accounts.push({
        name: name || descriptorParts[0] || "-",
        accountNumber,
        currentBalance,
        availableBalance,
        source: `table:${table.index}`,
      });
    }
  }

  return accounts;
}

function parseBlockAccounts(blocks) {
  const accounts = [];

  for (const block of blocks) {
    const text = normalizeText(block.text);
    if (!text) continue;

    const amounts = extractMoneyTexts(text);
    if (!amounts.length) continue;

    const lines = block.lines.map(normalizeText).filter(Boolean);
    const name =
      lines.find(
        (line) =>
          /[A-Za-z]/.test(line) &&
          !extractMoneyTexts(line).length &&
          !/^(current|available|balance|credit|debit|account)$/i.test(line)
      ) ?? "";
    const accountNumber = pickAccountIdentifier(lines);

    if (!name && !accountNumber) continue;

    const currentLine = lines.find(
      (line) =>
        /(current|ledger|closing|balance)/i.test(line) &&
        !/available/i.test(line) &&
        extractMoneyTexts(line).length
    );
    const availableLine = lines.find(
      (line) => /available/i.test(line) && extractMoneyTexts(line).length
    );

    accounts.push({
      name: name || accountNumber || "-",
      accountNumber,
      currentBalance:
        extractMoneyTexts(currentLine ?? "").at(-1) ?? amounts.at(-1) ?? "",
      availableBalance:
        extractMoneyTexts(availableLine ?? "").at(-1) ??
        (amounts.length > 1 ? amounts.at(-2) ?? "" : ""),
      source: `block:${block.index}`,
    });
  }

  return accounts;
}

function dedupeAccounts(accounts) {
  const seen = new Set();

  return accounts.filter((account) => {
    const key = [
      normalizeText(account.name).toLowerCase(),
      normalizeText(account.accountNumber),
      normalizeText(account.currentBalance),
      normalizeText(account.availableBalance),
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function accountIdFromButtonId(value) {
  const normalized = normalizeText(value);
  return normalized.replace(/^account-/, "");
}

export async function asbBalances() {
  const browser = await connectToChrome().catch((error) => {
    console.error("✗ Could not connect to Chrome:", error.message);
    console.error("  Make sure Chrome is running. Try: cashgrab browser");
    process.exit(1);
  });

  const page = (await browser.pages()).at(-1) ?? (await browser.newPage());

  await page.goto(BALANCES_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  await page
    .waitForFunction(() => document.readyState === "complete", {
      timeout: 10000,
    })
    .catch(() => {});

  await page
    .waitForFunction(() => {
      const frame = document.getElementById("everyday-banking-hub");
      const doc = frame?.contentDocument;
      return (doc?.querySelectorAll("#account-list button[id^='account-']").length ?? 0) > 0;
    }, {
      timeout: 10000,
    })
    .catch(() => {});

  const currentUrl = page.url();
  const pageTitle = await page.title().catch(() => "");

  if (AUTH_URL_PATTERN.test(currentUrl) || !APP_URL_PATTERN.test(currentUrl)) {
    await page
      .goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await browser.disconnect();
    console.error("✗ Not logged in. Expected an ASB FastNet balances page.");
    console.error(`  Current URL: ${currentUrl}`);
    console.error(`  Expected:    ${BALANCES_URL}`);
    if (pageTitle) {
      console.error(`  Page title:  ${pageTitle}`);
    }
    console.error(`  Opened:      ${LOGIN_URL}`);
    console.error("  Log in to ASB FastNet Classic and run the command again.");
    process.exit(1);
  }

  const data = await page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const getVisibleText = (value) => normalize(value?.innerText ?? value?.textContent ?? "");
    const hubFrame = document.getElementById("everyday-banking-hub");
    const hubDoc = hubFrame?.contentDocument ?? null;

    const iframeAccounts = hubDoc
      ? Array.from(hubDoc.querySelectorAll("#account-list button[id^='account-']")).map(
          (button) => ({
            buttonId: button.id,
            ariaLabel: normalize(button.getAttribute("aria-label") ?? ""),
            name: getVisibleText(button.querySelector("[class*='overline']")),
            primaryBalance: getVisibleText(
              button.querySelector(".primary-balance, [class*='primaryBalance'], [class*='balanceWrapper']")
            ),
            secondaryBalance: getVisibleText(
              button.querySelector(".secondary-balance, [class*='secondaryBalance']")
            ),
            supportingText: getVisibleText(
              button.querySelector("[class*='supportingText']")
            ),
            rawText: getVisibleText(button),
          })
        )
      : [];

    const tables = Array.from(document.querySelectorAll("table")).map((table, index) => ({
      index,
      caption: getVisibleText(table.querySelector("caption")),
      headings: Array.from(table.querySelectorAll("thead th")).map(getVisibleText),
      rows: Array.from(table.querySelectorAll("tr"))
        .map((row) => Array.from(row.cells ?? []).map(getVisibleText).filter(Boolean))
        .filter((row) => row.length > 0),
    }));

    const blocks = Array.from(
      document.querySelectorAll(
        "article, section, li, [role='row'], [class*='account'], [class*='balance']"
      )
    )
      .map((element, index) => {
        const text = normalize(element.innerText ?? "");
        const lines = (element.innerText ?? "")
          .split(/\n+/)
          .map(normalize)
          .filter(Boolean);

        return {
          index,
          tagName: element.tagName,
          className: normalize(element.className ?? ""),
          text,
          lines,
        };
      })
      .filter(
        (block) =>
          block.text &&
          block.text.length <= 400 &&
          block.lines.length <= 12 &&
          /\d[\d,]*\.\d{2}/.test(block.text)
      )
      .slice(0, 200);

    return {
      currentUrl: location.href,
      title: document.title,
      bodyText: normalize(document.body.innerText).slice(0, 500),
      iframeTitle: hubDoc?.title ?? "",
      iframeAccounts,
      headings: Array.from(document.querySelectorAll("h1, h2, h3"))
        .map(getVisibleText)
        .filter(Boolean)
        .slice(0, 10),
      tables,
      blocks,
    };
  });

  await browser.disconnect();

  const accounts = (
    data.iframeAccounts.length > 0
      ? data.iframeAccounts.map((account) => ({
          name: account.name || accountIdFromButtonId(account.buttonId) || "-",
          accountNumber: accountIdFromButtonId(account.buttonId),
          currentBalance: account.primaryBalance,
          availableBalance: account.secondaryBalance,
          note: account.supportingText,
          source: "iframe:everyday-banking-hub",
        }))
      : dedupeAccounts([
          ...parseTableAccounts(data.tables),
          ...parseBlockAccounts(data.blocks),
        ])
  ).map((account) => ({
    ...account,
    currentBalanceValue: parseCurrency(account.currentBalance),
    availableBalanceValue: parseCurrency(account.availableBalance),
  }));

  if (accounts.length === 0) {
    console.error("✗ Could not find any account balances on the ASB page.");
    console.error(`  Current URL: ${data.currentUrl}`);
    if (data.title) {
      console.error(`  Page title:  ${data.title}`);
    }
    if (data.iframeTitle) {
      console.error(`  Iframe:      ${data.iframeTitle}`);
    }
    if (data.headings.length) {
      console.error(`  Headings:    ${data.headings.join(" | ")}`);
    }
    if (data.bodyText) {
      console.error(`  Page says:   ${data.bodyText}`);
    }
    process.exit(1);
  }

  const pad = (value, width) => String(value ?? "-").padEnd(width);

  console.log("\nASB Account Balances\n");
  console.log(
    `${pad("Account", 28)} ${pad("Account ID", 20)} ${pad("Current Balance", 18)} Available / Detail`
  );
  console.log("─".repeat(96));

  for (const account of accounts) {
    const secondaryDisplay =
      typeof account.availableBalanceValue === "number"
        ? formatCurrency(account.availableBalanceValue)
        : account.note || "-";

    console.log(
      `${pad(account.name || "-", 28)} ${pad(account.accountNumber || "-", 20)} ${pad(formatCurrency(account.currentBalanceValue), 18)} ${secondaryDisplay}`
    );
  }

  console.log();
}
