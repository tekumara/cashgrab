/**
 * ASB Statement Download
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to the ASB Document Centre, searches within a date range,
 * paginates through all result pages, then downloads every matching
 * statement PDF.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to ASB FastNet Classic
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectToChrome } from "./connect-browser.js";
import { normalizeDateInput } from "./date-input.js";

const DOCUMENTS_URL = "https://online.asb.co.nz/fnc/1/goto/documents?referrer=fnc";
const LOGIN_URL = "https://online.asb.co.nz/auth/";
const APP_URL_PATTERN = /online\.asb\.co\.nz\/fnc\//i;
const AUTH_URL_PATTERN = /online\.asb\.co\.nz\/auth\//i;
const PAGE_SIZE = "200";

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

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

function normalizeCliDate(value) {
  if (!value) return null;
  if (value === "today") return formatToday();
  return normalizeDateInput(value);
}

function formatAsbDisplayDate(value) {
  const normalized = normalizeCliDate(value);
  const match = normalized?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return normalized ?? "";

  const [, day, month, year] = match;
  const monthIndex = Number(month) - 1;
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  return `${day} ${monthNames[monthIndex] ?? month} ${year}`;
}

function isNormalizedDate(value) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value ?? "");
}

function parseContentDispositionFilename(value) {
  if (!value) return null;

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }

  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  const bareMatch = value.match(/filename=([^;]+)/i);
  if (bareMatch) {
    return bareMatch[1].trim();
  }

  return null;
}

function fallbackFilename(statement) {
  return [
    statement.date.replace(/\s+/g, ""),
    slugify(statement.account),
    slugify(statement.type),
  ]
    .filter(Boolean)
    .join("_")
    .concat(".pdf");
}

export function normalizeAsbStatementOptions({
  date = null,
  from = null,
  to = null,
  accountQuery = "",
  outputDir = process.cwd(),
} = {}) {
  const opts = {
    date: normalizeCliDate(date),
    from: normalizeCliDate(from),
    to: normalizeCliDate(to),
    accountQuery: normalizeText(accountQuery),
    outputDir: outputDir ?? process.cwd(),
  };

  if (opts.date && (opts.from || opts.to)) {
    const isEquivalentExactDate =
      opts.from === opts.date && opts.to === opts.date;

    if (!isEquivalentExactDate) {
      console.error("✗ Use either --date or --from/--to, not both");
      process.exit(1);
    }
  }

  if ((opts.from && !opts.to) || (!opts.from && opts.to)) {
    console.error("✗ Both --from and --to are required for a date range");
    process.exit(1);
  }

  if (opts.date) {
    opts.from = opts.date;
    opts.to = opts.date;
  }

  if (!opts.from || !opts.to) {
    console.error("✗ Provide --date or --from/--to");
    process.exit(1);
  }

  if (!isNormalizedDate(opts.from) || !isNormalizedDate(opts.to)) {
    console.error("✗ Unsupported date format");
    console.error("  Use DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, or \"today\"");
    process.exit(1);
  }

  return opts;
}

function printNotLoggedIn({ currentUrl, pageTitle }) {
  console.error("✗ Not logged in. Expected an ASB Document Centre page.");
  console.error(`  Current URL: ${currentUrl}`);
  console.error(`  Expected:    ${DOCUMENTS_URL}`);
  if (pageTitle) {
    console.error(`  Page title:  ${pageTitle}`);
  }
  console.error(`  Opened:      ${LOGIN_URL}`);
  console.error("  Log in to ASB FastNet Classic and run the command again.");
  process.exit(1);
}

async function submitSearch(page, { from, to, pageNumber }) {
  await Promise.all([
    page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 15000,
    }),
    page.evaluate(
      ({ fromDate, toDate, currentPage, pageSize }) => {
        const form = document.getElementById("PagingForm");
        form.querySelector("#Request_SearchRequest_StartDate").value = fromDate;
        form.querySelector("#Request_SearchRequest_EndDate").value = toDate;
        form.querySelector("#Request_CurrentPageNumber").value = String(currentPage);

        const pageSizeSelect = form.querySelector("#Request_PageSize");
        if (pageSizeSelect) {
          pageSizeSelect.value = pageSize;
        }

        form.submit();
      },
      { fromDate: from, toDate: to, currentPage: pageNumber, pageSize: PAGE_SIZE }
    ),
  ]).catch(async () => {
    await page
      .waitForFunction(() => document.readyState === "complete", {
        timeout: 5000,
      })
      .catch(() => {});
  });

  await page
    .waitForFunction(() => document.readyState === "complete", {
      timeout: 10000,
    })
    .catch(() => {});
}

async function extractStatementsPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const rows = Array.from(document.querySelectorAll("table tr"))
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("th,td"));
        const link = row.querySelector("a.DownloadDocument");
        if (cells.length !== 4 || !link) return null;

        const [dateCell, accountCell, accountNameCell, typeCell] = cells;
        const date = normalize(link.textContent);
        const fileSize = normalize(dateCell.querySelector(".fileSize")?.textContent ?? "");
        const account = normalize(accountCell.textContent);
        const accountName = normalize(accountNameCell.textContent);
        const type = normalize(typeCell.textContent);

        return {
          date,
          fileSize,
          account,
          accountName,
          type,
          href: link.href,
          matchText: [account, accountName, type].join(" ").toLowerCase(),
        };
      })
      .filter(Boolean);

    const pageText = normalize(document.body.innerText);
    const pageMatch = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);

    return {
      currentUrl: location.href,
      title: document.title,
      bodyText: pageText.slice(0, 500),
      currentPage: pageMatch ? Number(pageMatch[1]) : 1,
      totalPages: pageMatch ? Number(pageMatch[2]) : 1,
      rows,
    };
  });
}

async function downloadStatement(page, statement) {
  const file = await page.evaluate(async (href) => {
    const response = await fetch(href, { credentials: "include" });
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return {
      ok: response.ok,
      status: response.status,
      contentDisposition: response.headers.get("content-disposition"),
      base64: btoa(binary),
    };
  }, statement.href);

  if (!file.ok) {
    throw new Error(`download failed with status ${file.status}`);
  }

  return file;
}

export async function asbStatements(options) {
  const opts = normalizeAsbStatementOptions(options);

  const browser = await connectToChrome().catch((error) => {
    console.error("✗ Could not connect to Chrome:", error.message);
    console.error("  Make sure Chrome is running. Try: cashgrab browser");
    process.exit(1);
  });

  const page = (await browser.pages()).at(-1) ?? (await browser.newPage());

  await page.goto(DOCUMENTS_URL, {
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

  await submitSearch(page, {
    from: opts.from,
    to: opts.to,
    pageNumber: 1,
  });

  const allRows = [];
  let pageData = await extractStatementsPage(page);

  while (true) {
    allRows.push(...pageData.rows);

    if (pageData.currentPage >= pageData.totalPages) {
      break;
    }

    await submitSearch(page, {
      from: opts.from,
      to: opts.to,
      pageNumber: pageData.currentPage + 1,
    });
    pageData = await extractStatementsPage(page);
  }

  const seenHrefs = new Set();
  const rows = allRows.filter((row) => {
    if (seenHrefs.has(row.href)) return false;
    seenHrefs.add(row.href);
    return true;
  });

  const matchingStatements = rows.filter(
    (row) =>
      /statement/i.test(row.type) &&
      (!opts.accountQuery || row.matchText.includes(opts.accountQuery.toLowerCase()))
  );

  if (matchingStatements.length === 0) {
    console.error(
      `✗ No ASB statements found from ${formatAsbDisplayDate(opts.from)} to ${formatAsbDisplayDate(
        opts.to
      )}${opts.accountQuery ? ` matching "${opts.accountQuery}"` : ""}`
    );
    if (pageData.currentUrl) {
      console.error(`  Current URL: ${pageData.currentUrl}`);
    }

    const availableStatements = rows
      .filter((row) => /statement/i.test(row.type))
      .map((row) => `${row.date} | ${row.account} | ${row.accountName} | ${row.type}`);

    if (availableStatements.length > 0) {
      console.error("  Available statements in that range:");
      for (const item of availableStatements) {
        console.error(`    ${item}`);
      }
    } else if (pageData.bodyText) {
      console.error(`  Page says:   ${pageData.bodyText}`);
    }

    await browser.disconnect();
    process.exit(1);
  }

  console.error(
    `Range:     ${formatAsbDisplayDate(opts.from)} - ${formatAsbDisplayDate(opts.to)}`
  );
  if (opts.accountQuery) {
    console.error(`Filter:    ${opts.accountQuery}`);
  }
  console.error(`Matches:   ${matchingStatements.length}`);

  for (const statement of matchingStatements) {
    const file = await downloadStatement(page, statement).catch(async (error) => {
      console.error(
        `✗ Failed to download ${statement.date} | ${statement.account} | ${statement.type}: ${error.message}`
      );
      await browser.disconnect();
      process.exit(1);
    });

    const outputFile = join(
      opts.outputDir,
      parseContentDispositionFilename(file.contentDisposition) ?? fallbackFilename(statement)
    );

    await writeFile(outputFile, Buffer.from(file.base64, "base64"));
    console.error(
      `✓ Saved:   ${statement.date} | ${statement.account} | ${statement.type} -> ${outputFile.split("/").pop()}`
    );
  }

  await browser.disconnect();
}
