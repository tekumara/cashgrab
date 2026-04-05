/**
 * St.George Account Balances
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to the St.George account portfolio page,
 * then prints all visible accounts and their balances.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to St.George Internet Banking
 */
import puppeteer from "puppeteer-core";

const BALANCES_URL =
  "https://ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html";
const LOGIN_URL = "https://ibanking.stgeorge.com.au/ibank/loginPage.action";
const CHROME_DEBUG_URL = "http://localhost:9222";

function parseCurrency(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^0-9.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";

  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(value);
}

export async function stGeorgeBalances() {
  const browser = await Promise.race([
    puppeteer.connect({
      browserURL: CHROME_DEBUG_URL,
      defaultViewport: null,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Connection timeout after 5s")), 5000)
    ),
  ]).catch((error) => {
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
      timeout: 5000,
    })
    .catch(() => {});

  const data = await page.evaluate(() => {
    const normalizeText = (value) => value?.replace(/\s+/g, " ").trim() ?? "";

    const accounts = Array.from(
      document.querySelectorAll("#acctSummaryList > li")
    ).map((item) => {
      const currentBalanceText =
        item.querySelector("dl.balance-details dd")?.textContent ?? "";

      return {
        name: normalizeText(
          item.querySelector("h2 a")?.textContent ?? item.dataset.acctalias ?? ""
        ),
        bsb: normalizeText(
          item.querySelector("dt.bsb-number + dd")?.textContent ?? ""
        ),
        accountNumber: normalizeText(
          item.querySelector("dt.account-number + dd")?.textContent ?? ""
        ),
        currentBalance:
          typeof item.dataset.currbal === "string"
            ? item.dataset.currbal
            : normalizeText(currentBalanceText),
        currentBalanceText: normalizeText(currentBalanceText),
        availableBalance: normalizeText(
          item.querySelector("dt.available-balance + dd")?.textContent ?? ""
        ),
      };
    });

    return {
      currentUrl: location.href,
      bodyText: normalizeText(document.body.innerText).slice(0, 500),
      accounts,
    };
  });

  if (data.accounts.length === 0) {
    await page
      .goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await browser.disconnect();
    console.error(
      "✗ Not logged in. Expected St.George account cards on the portfolio page."
    );
    console.error(`  Current URL: ${data.currentUrl}`);
    console.error(`  Expected:    ${BALANCES_URL}`);
    if (data.bodyText) {
      console.error(`  Page says:    ${data.bodyText}`);
    }
    console.error(`  Opened:      ${LOGIN_URL}`);
    console.error("  Log in to St.George Internet Banking and run the command again.");
    process.exit(1);
  }

  await browser.disconnect();

  const accounts = data.accounts.map((account) => ({
    ...account,
    currentBalanceValue:
      parseCurrency(account.currentBalance) ??
      parseCurrency(account.currentBalanceText),
    availableBalanceValue: parseCurrency(account.availableBalance),
  }));

  const pad = (value, width) => String(value ?? "-").padEnd(width);

  console.log("\nSt.George Account Balances\n");
  console.log(
    `${pad("Nickname", 28)} ${pad("BSB", 10)} ${pad("Account Number", 18)} ${pad("Current Balance", 18)} Available Balance`
  );
  console.log("─".repeat(94));

  for (const account of accounts) {
    console.log(
      `${pad(account.name || "-", 28)} ${pad(account.bsb || "-", 10)} ${pad(account.accountNumber || "-", 18)} ${pad(formatCurrency(account.currentBalanceValue), 18)} ${formatCurrency(account.availableBalanceValue)}`
    );
  }

  console.log();
}
