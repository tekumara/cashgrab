/**
 * Bankwest Transaction Export
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to Bankwest transaction search, runs a search for the
 * specified account and date range, then exports as MS Money (.qif).
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to Bankwest Online Banking
 */

import { mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToChrome } from "./connect-browser.js";

const SEARCH_URL =
  "https://online.bankwest.com.au/CMWeb/AccountInformation/TS/TransactionSearch.aspx";
const SEARCH_URL_PATTERN =
  /online\.bankwest\.com\.au\/CMWeb\/AccountInformation\/TS\/TransactionSearch\.aspx/;
// Normalize CLI-provided options and enforce valid date-range combinations.
export function normalizeTransactionOptions({
  accountQuery,
  range = "L30Days",
  from = null,
  to = null,
  outputDir = process.cwd(),
} = {}) {
  const opts = { accountQuery, range, from, to, outputDir: outputDir ?? process.cwd() };

  if (!opts.accountQuery) {
    console.error("✗ Account name is required");
    process.exit(1);
  }

  if (opts.to === "today") {
    const d = new Date();
    opts.to = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  if ((opts.from && !opts.to) || (opts.to && !opts.from)) {
    console.error("✗ Both --from and --to are required for custom date range");
    process.exit(1);
  }

  if (opts.from && opts.range !== "L30Days") {
    console.error("✗ Cannot use --range with --from/--to");
    process.exit(1);
  }

  if (opts.from) opts.range = "CUSTOM";

  return opts;
}

export async function bankwestTransactions(options) {
  const opts = normalizeTransactionOptions(options);

  const browser = await connectToChrome().catch((e) => {
    console.error("✗ Could not connect to Chrome:", e.message);
    console.error("  Make sure Chrome is running. Try: cashgrab browser");
    process.exit(1);
  });

  const page = (await browser.pages()).at(-1);

  if (!page) {
    console.error("✗ No active tab found");
    await browser.disconnect();
    process.exit(1);
  }

  // Navigate to transaction search page
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 15000 });

  const currentUrl = page.url();
  if (!SEARCH_URL_PATTERN.test(currentUrl)) {
    console.error("✗ Not logged in. Expected transaction search page.");
    console.error(`  Current URL: ${currentUrl}`);
    console.error("  Log in to Bankwest Online Banking first.");
    await browser.disconnect();
    process.exit(1);
  }

  // Match the requested account against the Bankwest dropdown contents.
  const account = await page.evaluate((query) => {
    const select = document.getElementById("_ctl0_ContentMain_ddlAccount");
    const options = Array.from(select.options).filter((o) => o.value !== "[All]");
    const q = query.toLowerCase();
    const matches = options.filter((o) => o.text.toLowerCase().includes(q));

    if (matches.length === 0) {
      return {
        error: `No account matching "${query}"`,
        available: options.map((o) => o.text),
      };
    }
    if (matches.length > 1) {
      return {
        error: `Ambiguous match for "${query}"`,
        available: matches.map((o) => o.text),
      };
    }

    return { value: matches[0].value, text: matches[0].text };
  }, opts.accountQuery);

  if (account.error) {
    console.error(`✗ ${account.error}`);
    console.error("  Available accounts:");
    for (const availableAccount of account.available) {
      console.error(`    ${availableAccount}`);
    }
    await browser.disconnect();
    process.exit(1);
  }

  const accountName = account.text.replace(/ - .*/, "");
  console.error(`Account: ${account.text}`);

  // Fill the search form and select MS Money export format.
  await page.evaluate(
    ({ accountValue, range, from, to }) => {
      document.getElementById("_ctl0_ContentMain_ddlAccount").value =
        accountValue;
      const rangeSelect = document.getElementById(
        "_ctl0_ContentMain_ddlRangeOptions"
      );
      rangeSelect.value = range;

      if (range === "CUSTOM") {
        rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        document.getElementById(
          "_ctl0_ContentMain_dpFromDate_txtDate"
        ).value = from;
        document.getElementById("_ctl0_ContentMain_dpToDate_txtDate").value =
          to;
      }

      // QIF export is exposed as "MSMoney" in Bankwest's UI.
      document.getElementById("_ctl0_ContentButtonsLeft_ddlExportType").value =
        "MSMoney";
    },
    { accountValue: account.value, range: opts.range, from: opts.from, to: opts.to }
  );

  console.error(`Range:   ${opts.range}${opts.from ? ` (${opts.from} - ${opts.to})` : ""}`);

  // ── Export ──────────────────────────────────────────────────────────────────
  const downloadDir = await mkdtemp(join(tmpdir(), "bankwest-"));

  const cdp = await page.createCDPSession();
  await cdp.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  // The export button triggers an ASP.NET postback that returns the download.
  await cdp.send("Runtime.evaluate", {
    expression:
      'setTimeout(() => document.getElementById("_ctl0_ContentButtonsLeft_btnExport").click(), 50)',
  });

  // Poll for the downloaded QIF file to appear in the temp directory.
  let downloadedFile = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const files = await readdir(downloadDir);
    const qif = files.find((f) => f.endsWith(".qif"));
    if (qif) {
      downloadedFile = join(downloadDir, qif);
      break;
    }
  }

  if (!downloadedFile) {
    console.error("✗ Export timed out - no .qif file received");
    await browser.disconnect();
    process.exit(1);
  }

  // Rename the downloaded file to include the matched account label.
  const baseName = downloadedFile.split("/").pop().replace(".qif", "");
  const suffix = accountName.replace(/\s+/g, "_");
  const outputFile = join(opts.outputDir, `${baseName}_${suffix}.qif`);

  await rename(downloadedFile, outputFile);

  console.error(`✓ Exported: ${outputFile.split("/").pop()}`);

  await browser.disconnect();
}
