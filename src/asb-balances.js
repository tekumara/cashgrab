/**
 * ASB Account Balances
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to the ASB balances page, then prints all visible accounts and
 * their balances from the Everyday Banking Hub iframe.
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
const HUB_FRAME_ID = "everyday-banking-hub";
const ACCOUNT_CARD_SELECTOR = "#account-list button[id^='account-']";

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
  const normalized = trimmed.replace(/[^0-9.-]/g, "");

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

function accountIdFromButtonId(value) {
  return normalizeText(value).replace(/^account-/, "");
}

function printNotLoggedIn({ currentUrl, pageTitle }) {
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

function printNoAccounts(data) {
  console.error("✗ Could not find any account balances on the ASB page.");
  console.error(`  Current URL: ${data.currentUrl}`);
  if (data.title) {
    console.error(`  Page title:  ${data.title}`);
  }
  if (data.iframeTitle) {
    console.error(`  Iframe:      ${data.iframeTitle}`);
  }
  if (data.bodyText) {
    console.error(`  Page says:   ${data.bodyText}`);
  }
  process.exit(1);
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
    printNotLoggedIn({ currentUrl, pageTitle });
  }

  await page
    .waitForFunction(
      ({ frameId, cardSelector }) => {
        const hubDoc = document.getElementById(frameId)?.contentDocument;
        return (hubDoc?.querySelectorAll(cardSelector).length ?? 0) > 0;
      },
      { timeout: 10000 },
      { frameId: HUB_FRAME_ID, cardSelector: ACCOUNT_CARD_SELECTOR }
    )
    .catch(() => {});

  const data = await page.evaluate(({ frameId, cardSelector }) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const text = (node) => normalize(node?.innerText ?? node?.textContent ?? "");
    const hubDoc = document.getElementById(frameId)?.contentDocument ?? null;

    const accounts = hubDoc
      ? Array.from(hubDoc.querySelectorAll(cardSelector)).map((button) => ({
          buttonId: button.id,
          name: text(button.querySelector("[class*='overline']")),
          currentBalance: text(
            button.querySelector(
              ".primary-balance, [class*='primaryBalance'], [class*='balanceWrapper']"
            )
          ),
          availableBalance: text(
            button.querySelector(".secondary-balance, [class*='secondaryBalance']")
          ),
          note: text(button.querySelector("[class*='supportingText']")),
        }))
      : [];

    return {
      currentUrl: location.href,
      title: document.title,
      bodyText: text(document.body).slice(0, 500),
      iframeTitle: hubDoc?.title ?? "",
      accounts,
    };
  }, { frameId: HUB_FRAME_ID, cardSelector: ACCOUNT_CARD_SELECTOR });

  await browser.disconnect();

  if (data.accounts.length === 0) {
    printNoAccounts(data);
  }

  const accounts = data.accounts.map((account) => ({
    ...account,
    accountId: accountIdFromButtonId(account.buttonId),
    currentBalanceValue: parseCurrency(account.currentBalance),
    availableBalanceValue: parseCurrency(account.availableBalance),
  }));

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
      `${pad(account.name || account.accountId || "-", 28)} ${pad(account.accountId || "-", 20)} ${pad(formatCurrency(account.currentBalanceValue), 18)} ${secondaryDisplay}`
    );
  }

  console.log();
}
