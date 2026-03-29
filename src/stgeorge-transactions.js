/**
 * St.George Transaction Export
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates from the St.George account portfolio page to the matched
 * account details page, then exports transactions as CSV.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to St.George Internet Banking
 */

import puppeteer from "puppeteer-core";
import { mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORTFOLIO_URL =
  "https://ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html";
const CHROME_DEBUG_URL = "http://localhost:9222";

const RANGE_TO_SELECTED_OPTION = {
  L7Days: 0,
  L30Days: 1,
  CUSTOM: 2,
};

function slugify(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "");
}

function formatToday() {
  const today = new Date();
  return `${String(today.getDate()).padStart(2, "0")}/${String(
    today.getMonth() + 1
  ).padStart(2, "0")}/${today.getFullYear()}`;
}

export function normalizeStGeorgeTransactionOptions({
  accountQuery,
  range = "L30Days",
  from = null,
  to = null,
  outputDir = process.cwd(),
} = {}) {
  const opts = {
    accountQuery,
    range,
    from,
    to,
    outputDir: outputDir ?? process.cwd(),
  };

  if (!opts.accountQuery) {
    console.error("✗ Account name is required");
    process.exit(1);
  }

  if (opts.to === "today") {
    opts.to = formatToday();
  }

  if ((opts.from && !opts.to) || (opts.to && !opts.from)) {
    console.error("✗ Both --from and --to are required for custom date range");
    process.exit(1);
  }

  if (opts.from && opts.range !== "L30Days") {
    console.error("✗ Cannot use --range with --from/--to");
    process.exit(1);
  }

  if (opts.from) {
    opts.range = "CUSTOM";
  }

  if (!["L7Days", "L30Days", "CUSTOM"].includes(opts.range)) {
    console.error(`✗ Unsupported St.George range "${opts.range}"`);
    console.error("  Supported ranges: L7Days, L30Days, or --from/--to");
    process.exit(1);
  }

  return opts;
}

export async function stGeorgeTransactions(options) {
  const opts = normalizeStGeorgeTransactionOptions(options);

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

  await page.goto(PORTFOLIO_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  await page
    .waitForFunction(() => document.readyState === "complete", {
      timeout: 5000,
    })
    .catch(() => {});

  const account = await page.evaluate((query) => {
    const normalizeText = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const items = Array.from(document.querySelectorAll("#acctSummaryList > li"));
    const q = query.toLowerCase();

    const accounts = items.map((item) => {
      const name = normalizeText(
        item.querySelector("h2 a")?.textContent ?? item.dataset.acctalias ?? ""
      );
      const bsb = normalizeText(
        item.querySelector("dt.bsb-number + dd")?.textContent ?? ""
      );
      const accountNumber = normalizeText(
        item.querySelector("dt.account-number + dd")?.textContent ?? ""
      );
      const href = item.querySelector("h2 a")?.getAttribute("href") ?? "";
      const label = [name, accountNumber].filter(Boolean).join(" ");
      const matchText = [name, accountNumber, bsb].join(" ").toLowerCase();
      const indexMatch = href.match(/accountDetails\.action\?index=(\d+)/);

      return {
        index: indexMatch?.[1] ?? null,
        name,
        bsb,
        accountNumber,
        href,
        label,
        matchText,
      };
    });

    if (accounts.length === 0) {
      return {
        error: "Not logged in. Expected St.George account cards on the portfolio page.",
        currentUrl: location.href,
        available: [],
      };
    }

    const matches = accounts.filter((account) => account.matchText.includes(q));

    if (matches.length === 0) {
      return {
        error: `No account matching "${query}"`,
        currentUrl: location.href,
        available: accounts.map((account) => account.label),
      };
    }

    if (matches.length > 1) {
      return {
        error: `Ambiguous match for "${query}"`,
        currentUrl: location.href,
        available: matches.map((account) => account.label),
      };
    }

    return {
      currentUrl: location.href,
      account: matches[0],
    };
  }, opts.accountQuery);

  if (account.error) {
    console.error(`✗ ${account.error}`);
    if (account.currentUrl) {
      console.error(`  Current URL: ${account.currentUrl}`);
    }
    if (account.available.length > 0) {
      console.error("  Available accounts:");
      for (const availableAccount of account.available) {
        console.error(`    ${availableAccount}`);
      }
    }
    await browser.disconnect();
    process.exit(1);
  }

  if (!account.account?.index) {
    console.error("✗ Could not determine St.George account index");
    await browser.disconnect();
    process.exit(1);
  }

  const accountUrl = new URL(
    `accountDetails.action?index=${account.account.index}`,
    PORTFOLIO_URL
  ).toString();

  await page.goto(accountUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  await page
    .waitForFunction(() => document.readyState === "complete", {
      timeout: 5000,
    })
    .catch(() => {});

  const accountDetails = await page.evaluate((expectedIndex) => {
    const info = document.querySelector("div.account-info");
    return {
      currentUrl: location.href,
      pageIndex: info?.id ?? null,
      visibleAccount: info?.innerText?.replace(/\s+/g, " ").trim() ?? "",
      hasExportControl: !!document.getElementById("transHistExport"),
      bodyText: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 500),
      expectedIndex,
    };
  }, account.account.index);

  if (
    !accountDetails.hasExportControl ||
    accountDetails.pageIndex !== String(accountDetails.expectedIndex)
  ) {
    console.error("✗ Could not load the St.George account details export page.");
    console.error(`  Current URL: ${accountDetails.currentUrl}`);
    if (accountDetails.bodyText) {
      console.error(`  Page says:    ${accountDetails.bodyText}`);
    }
    await browser.disconnect();
    process.exit(1);
  }

  const selectedOption = RANGE_TO_SELECTED_OPTION[opts.range];
  const downloadUrl = await page.evaluate(
    ({ index, selectedOption, from, to }) => {
      const params = new URLSearchParams({
        newPage: "1",
        index: String(index),
        exportFileFormat: "CSV",
        exportDateFormat: "dd/MM/yyyy",
        selectedOption: String(selectedOption),
        dateFrom: from ?? "",
        dateTo: to ?? "",
        selectedAmountFrom: "",
        selectedAmountTo: "",
        selectedDrCrOption: "0",
        includeCategories: "true",
        includeSubCategories: "true",
      });

      return new URL(`exportTransactions.action?${params.toString()}`, location.href).toString();
    },
    {
      index: account.account.index,
      selectedOption,
      from: opts.from,
      to: opts.to,
    }
  );

  console.error(`Account: ${account.account.label}`);
  console.error(
    `Range:   ${opts.range}${opts.from ? ` (${opts.from} - ${opts.to})` : ""}`
  );

  const downloadDir = await mkdtemp(join(tmpdir(), "stgeorge-"));

  const cdp = await page.createCDPSession();
  await cdp.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  await cdp.send("Runtime.evaluate", {
    expression: `setTimeout(() => { window.location.href = ${JSON.stringify(
      downloadUrl
    )}; }, 50)`,
  });

  let downloadedFile = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const files = await readdir(downloadDir);
    const csv = files.find(
      (file) => file.endsWith(".csv") && !file.endsWith(".crdownload")
    );
    if (csv) {
      downloadedFile = join(downloadDir, csv);
      break;
    }
  }

  if (!downloadedFile) {
    console.error("✗ Export timed out - no .csv file received");
    await browser.disconnect();
    process.exit(1);
  }

  const baseName = downloadedFile.split("/").pop().replace(/\.csv$/i, "");
  const suffix = `${slugify(account.account.name)}_${slugify(
    account.account.accountNumber
  )}`;
  const outputFile = join(opts.outputDir, `${baseName}_${suffix}.csv`);

  await rename(downloadedFile, outputFile);

  console.error(`✓ Exported: ${outputFile.split("/").pop()}`);

  await browser.disconnect();
}
