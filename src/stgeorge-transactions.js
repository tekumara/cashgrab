/**
 * St.George Transaction Export
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates from the St.George account portfolio page to the matched
 * account details page, then either exports transactions as CSV or
 * pages through the HTML transaction history and writes its own CSV.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to St.George Internet Banking
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectToChrome } from "./connect-browser.js";
import { normalizeDateInput } from "./date-input.js";
import {
  buildStGeorgeTransactionsCsv,
  countCsvRecords,
  normalizeStGeorgeDownloadCsv,
} from "./stgeorge-transaction-normalization.js";

const PORTFOLIO_URL =
  "https://ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html";
const LOGIN_URL = "https://ibanking.stgeorge.com.au/ibank/loginPage.action";

const RANGE_TO_SELECTED_OPTION = {
  L7Days: 0,
  L30Days: 1,
  CUSTOM: 2,
};

const RANGE_TO_PANEL_ID = {
  L7Days: "transaction-7days",
  L30Days: "transaction-30days",
  CUSTOM: "transaction-date-range",
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

function formatDateForFileName(value) {
  const match = String(value ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return slugify(value);
  }

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function buildHtmlExportBaseName({ range, from, to }) {
  if (from && to) {
    if (from === to) {
      return `transactions_html_${formatDateForFileName(from)}`;
    }

    return `transactions_html_${formatDateForFileName(from)}_to_${formatDateForFileName(
      to
    )}`;
  }

  return `transactions_html_${String(range).toLowerCase()}`;
}

async function extractHtmlTransactions(page, { range, selectedOption, from, to }) {
  return page.evaluate(
    async ({ panelId, selectedOption, from, to }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalizeText = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
      const panel = document.getElementById(panelId);

      if (!panel) {
        return {
          error: `Could not find transaction history panel "${panelId}".`,
          currentUrl: location.href,
        };
      }

      const getTableBody = () => panel.querySelector("#th-table-body");
      const getPagination = () => {
        const recordText = normalizeText(
          panel.querySelector("div.pagination .record-count")?.textContent ?? ""
        );
        const pageMatch = recordText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
        const selectedText = normalizeText(
          panel.querySelector("div.pagination a.selected")?.textContent ?? ""
        );

        return {
          currentPage:
            Number(selectedText) || (pageMatch ? Number(pageMatch[1]) : 1),
          totalPages: pageMatch ? Number(pageMatch[2]) : 1,
          recordText,
        };
      };

      const extractRowsFromPanel = () => {
        const headings = Array.from(panel.querySelectorAll("thead th")).map((th) =>
          normalizeText(th.textContent).toLowerCase()
        );
        const indexFor = (label) => headings.indexOf(label.toLowerCase());
        const dateIndex = indexFor("date");
        const descriptionIndex = indexFor("description");
        const categoryIndex = indexFor("category");
        const debitIndex = indexFor("debit");
        const creditIndex = indexFor("credit");
        const balanceIndex = indexFor("balance");

        return Array.from(panel.querySelectorAll("#th-table-body tr"))
          .map((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) =>
              normalizeText(td.innerText || td.textContent)
            )
          )
          .map((cells) => ({
            date: cells[dateIndex] ?? "",
            description: cells[descriptionIndex] ?? "",
            category: categoryIndex >= 0 ? cells[categoryIndex] ?? "" : "",
            debit: cells[debitIndex] ?? "",
            credit: cells[creditIndex] ?? "",
            balance: balanceIndex >= 0 ? cells[balanceIndex] ?? "" : "",
          }))
          .filter((row) => /^\d{2}\/\d{2}\/\d{4}$/.test(row.date));
      };

      const waitForPanelUpdate = (expectedPage, previousSignature) =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 20000;
          let spinnerSeen = false;

          const tick = () => {
            const errorText = normalizeText(
              document.getElementById("actionError")?.textContent ?? ""
            );
            if (errorText) {
              resolve({ error: errorText });
              return;
            }

            const body = getTableBody();
            const signature = body?.innerHTML ?? "";
            const rows = Array.from(panel.querySelectorAll("#th-table-body tr"));
            const spinner = !!panel.querySelector(".spin");
            const noTransactions = rows.some((row) =>
              /No transactions found/i.test(normalizeText(row.textContent))
            );
            const pagination = getPagination();
            const hasPagination = !!panel.querySelector("div.pagination");
            const pageMatches = hasPagination
              ? pagination.currentPage === expectedPage
              : expectedPage === 1;

            if (spinner) {
              spinnerSeen = true;
            }

            if (
              !spinner &&
              rows.length > 0 &&
              pageMatches &&
              (spinnerSeen || signature !== previousSignature || noTransactions)
            ) {
              resolve({ pagination, noTransactions });
              return;
            }

            if (Date.now() > deadline) {
              reject(new Error(`Timed out waiting for transaction page ${expectedPage}`));
              return;
            }

            setTimeout(tick, 100);
          };

          tick();
        });

      const waitForPaginationToSettle = async () => {
        const deadline = Date.now() + 5000;
        let stableTicks = 0;
        let lastPaginationMarkup = panel.querySelector("div.pagination")?.innerHTML ?? "";

        while (Date.now() < deadline) {
          const errorText = normalizeText(
            document.getElementById("actionError")?.textContent ?? ""
          );
          if (errorText) {
            return { error: errorText };
          }

          const pagination = getPagination();
          if (pagination.recordText) {
            return pagination;
          }

          const paginationMarkup = panel.querySelector("div.pagination")?.innerHTML ?? "";
          const visibleRowCount = panel.querySelectorAll("#th-table-body tr").length;
          const extractedRowCount = extractRowsFromPanel().length;
          const pageLooksFull = visibleRowCount >= 25 || extractedRowCount >= 24;

          if (paginationMarkup !== lastPaginationMarkup) {
            lastPaginationMarkup = paginationMarkup;
            stableTicks = 0;
          } else {
            stableTicks += 1;
          }

          if (!pageLooksFull && stableTicks >= 5) {
            return getPagination();
          }

          await sleep(100);
        }

        return getPagination();
      };

      const setFieldValue = (selector, value) => {
        const input = panel.querySelector(selector);
        if (!input) return false;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };

      const tabLink = document.querySelector(`#transhisttabs a[href="#${panelId}"]`);
      tabLink?.click();
      await sleep(150);

      if (selectedOption === 2) {
        const hasFromField = setFieldValue("#acctDetDateFrom", from ?? "");
        const hasToField = setFieldValue("#acctDetDateTo", to ?? "");
        const searchButton = panel.querySelector('input[name="go"]');

        if (!hasFromField || !hasToField || !searchButton) {
          return {
            error: "Could not find the St.George custom date transaction search controls.",
            currentUrl: location.href,
          };
        }

        const previousSignature = getTableBody()?.innerHTML ?? "";
        searchButton.click();
        const firstLoad = await waitForPanelUpdate(1, previousSignature).catch(
          (error) => ({ error: error.message })
        );

        if (firstLoad?.error) {
          return {
            error: firstLoad.error,
            currentUrl: location.href,
          };
        }
      }

      const settledPagination = await waitForPaginationToSettle();
      if (settledPagination?.error) {
        return {
          error: settledPagination.error,
          currentUrl: location.href,
        };
      }

      const initialRows = extractRowsFromPanel();
      const initialPagination = settledPagination?.recordText
        ? settledPagination
        : getPagination();
      const dedupedRows = [];
      const seen = new Set();

      const addRows = (rows) => {
        for (const row of rows) {
          const key = JSON.stringify(row);
          if (!seen.has(key)) {
            seen.add(key);
            dedupedRows.push(row);
          }
        }
      };

      addRows(initialRows);

      if (initialPagination.totalPages > 1) {
        if (typeof getNextPage !== "function") {
          return {
            error: "St.George pagination controls are unavailable on the transaction history page.",
            currentUrl: location.href,
          };
        }

        for (let pageNumber = 2; pageNumber <= initialPagination.totalPages; pageNumber++) {
          const previousSignature = getTableBody()?.innerHTML ?? "";
          getNextPage(String(pageNumber));

          const pageState = await waitForPanelUpdate(
            pageNumber,
            previousSignature
          ).catch((error) => ({ error: error.message }));

          if (pageState?.error) {
            return {
              error: pageState.error,
              currentUrl: location.href,
            };
          }

          addRows(extractRowsFromPanel());
        }
      }

      return {
        currentUrl: location.href,
        panelId,
        totalPages: initialPagination.totalPages,
        rows: dedupedRows,
      };
    },
    {
      panelId: RANGE_TO_PANEL_ID[range],
      selectedOption,
      from,
      to,
    }
  );
}

export function normalizeStGeorgeTransactionOptions({
  accountQuery,
  range = "L30Days",
  from = null,
  to = null,
  date = null,
  html = false,
  outputDir = process.cwd(),
} = {}) {
  const opts = {
    accountQuery,
    range,
    from,
    to,
    date,
    html: Boolean(html),
    outputDir: outputDir ?? process.cwd(),
  };

  if (!opts.accountQuery) {
    console.error("✗ Account name is required");
    process.exit(1);
  }

  if (opts.to === "today") {
    opts.to = formatToday();
  }

  if (opts.date === "today") {
    opts.date = formatToday();
  }

  if (opts.date) {
    opts.date = normalizeDateInput(opts.date);
  }

  // Normalize accepted CLI input formats to the DD/MM/YYYY form expected by St.George.
  if (opts.from) opts.from = normalizeDateInput(opts.from);
  if (opts.to) opts.to = normalizeDateInput(opts.to);

  if (opts.date && (opts.from || opts.to)) {
    console.error("✗ --date cannot be combined with --from/--to");
    process.exit(1);
  }

  if (opts.date) {
    opts.from = opts.date;
    opts.to = opts.date;
    opts.range = "CUSTOM";
    opts.date = null;
  }

  if ((opts.from && !opts.to) || (opts.to && !opts.from)) {
    console.error("✗ Both --from and --to are required for custom date range");
    process.exit(1);
  }

  if (opts.from) {
    opts.range = "CUSTOM";
  }

  if (!Object.hasOwn(RANGE_TO_SELECTED_OPTION, opts.range)) {
    console.error(`✗ Unsupported St.George range "${opts.range}"`);
    console.error("  Supported ranges: L7Days, L30Days, or --from/--to");
    process.exit(1);
  }

  return opts;
}

export async function stGeorgeTransactions(options) {
  const opts = normalizeStGeorgeTransactionOptions(options);

  const browser = await connectToChrome().catch((error) => {
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
        notLoggedIn: true,
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
    if (account.notLoggedIn) {
      await page
        .goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        .catch(() => {});
    }
    console.error(`✗ ${account.error}`);
    if (account.currentUrl) {
      console.error(`  Current URL: ${account.currentUrl}`);
    }
    if (account.notLoggedIn) {
      console.error(`  Opened:      ${LOGIN_URL}`);
      console.error(
        "  Log in to St.George Internet Banking and run the command again."
      );
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
    if (accountDetails.currentUrl.includes("loginPage.action")) {
      await page
        .goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        .catch(() => {});
      console.error("✗ Not logged in to St.George Internet Banking.");
      console.error(`  Current URL: ${accountDetails.currentUrl}`);
      console.error(`  Opened:      ${LOGIN_URL}`);
      console.error(
        "  Log in to St.George Internet Banking and run the command again."
      );
      await browser.disconnect();
      process.exit(1);
    }
    console.error("✗ Could not load the St.George account details export page.");
    console.error(`  Current URL: ${accountDetails.currentUrl}`);
    if (accountDetails.bodyText) {
      console.error(`  Page says:    ${accountDetails.bodyText}`);
    }
    await browser.disconnect();
    process.exit(1);
  }

  const selectedOption = RANGE_TO_SELECTED_OPTION[opts.range];
  const suffix = `${slugify(account.account.name)}_${slugify(
    account.account.accountNumber
  )}`;

  console.error(`Account: ${account.account.label}`);
  console.error(
    `Range:   ${opts.range}${opts.from ? ` (${opts.from} - ${opts.to})` : ""}`
  );

  if (opts.html) {
    const htmlResult = await extractHtmlTransactions(page, {
      range: opts.range,
      selectedOption,
      from: opts.from,
      to: opts.to,
    });

    if (htmlResult.error) {
      console.error(`✗ ${htmlResult.error}`);
      if (htmlResult.currentUrl) {
        console.error(`  Current URL: ${htmlResult.currentUrl}`);
      }
      await browser.disconnect();
      process.exit(1);
    }

    const outputFile = join(
      opts.outputDir,
      `${buildHtmlExportBaseName(opts)}_${suffix}.csv`
    );
    const csvContent = buildStGeorgeTransactionsCsv(htmlResult.rows);

    await writeFile(outputFile, csvContent, "utf8");

    console.error("Mode:    HTML transaction history");
    console.error(`Pages:   ${htmlResult.totalPages}`);
    console.error(`✓ Exported: ${outputFile.split("/").pop()}`);
    console.error(`Transactions: ${htmlResult.rows.length}`);

    await browser.disconnect();
    return;
  }

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

  // St.George export responses depend on transaction-history state being
  // established first; jumping straight to export can return an empty CSV.
  const historyResult = await page.evaluate(
    async ({ index, selectedOption, from, to }) => {
      const params = new URLSearchParams({
        newPage: "1",
        transactionHistoryPage: "false",
        index: String(index),
        selectedOption: String(selectedOption),
        dateFrom: from ?? "",
        dateTo: to ?? "",
        selectedDrCrOption: "0",
        selectedAmountFrom: "",
        selectedAmountTo: "",
        page: "1",
        action: "transactionHistory",
      });

      const response = await fetch("showTransactionHistory.action", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: params.toString(),
      });

      return {
        ok: response.ok,
        status: response.status,
      };
    },
    {
      index: account.account.index,
      selectedOption,
      from: opts.from,
      to: opts.to,
    }
  );

  if (!historyResult.ok) {
    console.error(
      `✗ Transaction history request failed with HTTP ${historyResult.status}`
    );
    await browser.disconnect();
    process.exit(1);
  }

  const exportResult = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "include",
    });
    const content = await response.text();
    const disposition = response.headers.get("content-disposition") ?? "";
    const fileNameMatch = disposition.match(/filename="?([^"]+)"?/i);

    return {
      ok: response.ok,
      status: response.status,
      content,
      fileName: fileNameMatch?.[1] ?? null,
    };
  }, downloadUrl);

  if (!exportResult.ok) {
    console.error(`✗ Export failed with HTTP ${exportResult.status}`);
    await browser.disconnect();
    process.exit(1);
  }

  const baseName = (exportResult.fileName ?? "transactions.csv").replace(
    /\.csv$/i,
    ""
  );
  const outputFile = join(opts.outputDir, `${baseName}_${suffix}.csv`);
  const normalizedContent = normalizeStGeorgeDownloadCsv(exportResult.content);
  const transactionCount = countCsvRecords(normalizedContent);

  await writeFile(outputFile, normalizedContent, "utf8");

  console.error(`✓ Exported: ${outputFile.split("/").pop()}`);
  console.error(`Transactions: ${transactionCount}`);

  await browser.disconnect();
}
