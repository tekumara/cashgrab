/**
 * Dodo Invoice Download
 *
 * Connects to a running Chrome instance (CDP on localhost:9222), expects the
 * active tab to already be on a logged-in Dodo billing overview page for a
 * specific service, switches to the previous invoices view, then downloads all
 * matching invoice PDFs.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to My Dodo
 *   - Desired service page already open at https://my.dodo.com/billing-overview...
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectToChrome } from "./connect-browser.js";
import { normalizeDateInput } from "./date-input.js";

const BILLING_URL_PREFIX = "https://my.dodo.com/billing-overview";
const LOGIN_URL = "https://my.dodo.com/login-email";
const LOGIN_DASHBOARD_URL = "https://my.dodo.com/dashboard";
const MONTH_NUMBERS = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

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

function isNormalizedDate(value) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value ?? "");
}

function parseDateToIso(value) {
  const text = normalizeText(value).replace(/,/g, "");
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    return `${match[3]}-${month}-${day}`;
  }

  match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    return `${match[3]}-${month}-${day}`;
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (match) {
    const month = MONTH_NUMBERS[match[2].toLowerCase()];
    if (!month) return null;
    return `${match[3]}-${month}-${match[1].padStart(2, "0")}`;
  }

  match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  if (match) {
    const month = MONTH_NUMBERS[match[1].toLowerCase()];
    if (!month) return null;
    return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
  }

  return null;
}

function formatDisplayDate(value) {
  const iso = parseDateToIso(value);
  if (!iso) return value ?? "";

  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
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

function fallbackFilename(invoice) {
  return [
    parseDateToIso(invoice.dateText) ?? "invoice",
    "dodo",
    slugify(invoice.invoiceNumber || invoice.dateText || "invoice"),
  ]
    .filter(Boolean)
    .join("_")
    .concat(".pdf");
}

function printNotLoggedIn({ currentUrl, pageTitle }) {
  console.error("✗ Not logged in to My Dodo.");
  console.error(`  Current URL: ${currentUrl}`);
  if (pageTitle) {
    console.error(`  Page title:  ${pageTitle}`);
  }
  console.error(`  Opened:      ${LOGIN_URL}`);
  console.error("  Log in to My Dodo and reopen the billing overview service page.");
  process.exit(1);
}

function printWrongPage({ currentUrl, pageTitle }) {
  console.error("✗ Expected an open Dodo billing overview service page.");
  console.error(`  Current URL: ${currentUrl}`);
  console.error(`  Expected:    ${BILLING_URL_PREFIX}...`);
  if (pageTitle) {
    console.error(`  Page title:  ${pageTitle}`);
  }
  console.error(
    "  Open the desired Dodo service page first, then run the command again."
  );
  process.exit(1);
}

function isDodoAuthFailure({ bodyText = "" } = {}) {
  return /jwt token is required/i.test(bodyText);
}

function dodoAuthErrorMessage() {
  return `Dodo session expired or redirected to login; log in again at ${LOGIN_DASHBOARD_URL} and reopen the billing overview page`;
}

export function normalizeDodoInvoiceOptions({
  date = null,
  from = null,
  to = null,
  outputDir = process.cwd(),
} = {}) {
  const opts = {
    date: normalizeCliDate(date),
    from: normalizeCliDate(from),
    to: normalizeCliDate(to),
    outputDir: outputDir ?? process.cwd(),
  };

  if (opts.date && (opts.from || opts.to)) {
    console.error("✗ Use either --date or --from/--to, not both");
    process.exit(1);
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

  const invalidDateValues = [...new Set([opts.date, opts.from, opts.to].filter(
    (value) => value && !isNormalizedDate(value)
  ))];

  if (invalidDateValues.length > 0) {
    console.error(
      `✗ Unsupported date format: ${invalidDateValues.map((value) => `"${value}"`).join(", ")}`
    );
    console.error("  Use DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, or \"today\"");
    process.exit(1);
  }

  return opts;
}

function pickDodoPage(pages) {
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    if (pages[i].url().startsWith(BILLING_URL_PREFIX)) {
      return pages[i];
    }
  }

  return pages.at(-1) ?? null;
}

async function waitForReady(page) {
  await page
    .waitForFunction(() => document.readyState === "complete", {
      timeout: 10000,
    })
    .catch(() => {});
}

async function openPreviousInvoices(page) {
  const result = await page.evaluate(() => {
    const exactTab = document.getElementById("previous-invoice-tab");
    if (!(exactTab instanceof HTMLElement)) {
      const hasInvoiceRows = document.querySelectorAll("#previous-invoice .__content").length > 0;
      if (hasInvoiceRows) {
        return {
          ok: true,
          currentUrl: location.href,
        };
      }

      return {
        ok: false,
        error: 'Could not find a "Previous Invoices" tab or link on the page.',
        currentUrl: location.href,
      };
    }

    const selected =
      exactTab.getAttribute("aria-selected") === "true" ||
      exactTab.classList.contains("active");

    if (!selected) {
      exactTab.click();
    }

    return {
      ok: true,
      currentUrl: location.href,
    };
  });

  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    console.error(`  Current URL: ${result.currentUrl}`);
    process.exit(1);
  }

  await waitForReady(page);
  await page
    .waitForFunction(
      () => document.querySelectorAll("#previous-invoice .__content").length > 0,
      { timeout: 5000 }
    )
    .catch(() => {});

  return result;
}

async function extractInvoices(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const rows = Array.from(document.querySelectorAll("#previous-invoice .__content"));
    const invoices = rows.map((row, index) => {
      const infoValues = Array.from(row.querySelectorAll(".___column .____info")).map((node) =>
        normalize(node.textContent)
      );
      const button = row.querySelector("button");

      return {
        index,
        invoiceNumber: infoValues[0] ?? "",
        dateText: infoValues[1] ?? "",
        amountText: infoValues[2] ?? "",
        buttonText: normalize(button?.innerText || button?.textContent || ""),
        context: normalize(row.innerText || row.textContent || "").slice(0, 500),
      };
    });

    return {
      currentUrl: location.href,
      bodyText: normalize(document.body.innerText).slice(0, 1000),
      invoices,
    };
  });
}

async function reopenPreviousInvoicesIfNeeded(page) {
  if (page.url().startsWith(BILLING_URL_PREFIX)) {
    await openPreviousInvoices(page);
  }
}

function withinRange(invoice, opts) {
  const invoiceIso = parseDateToIso(invoice.dateText);
  const fromIso = parseDateToIso(opts.from);
  const toIso = parseDateToIso(opts.to);

  if (!invoiceIso || !fromIso || !toIso) {
    return false;
  }

  return invoiceIso >= fromIso && invoiceIso <= toIso;
}

async function waitForPdfPage(browser, originalPage, originalUrl) {
  for (let i = 0; i < 30; i += 1) {
    const pages = await browser.pages();

    const popupPage = [...pages]
      .reverse()
      .find((candidate) => candidate !== originalPage && candidate.url());

    if (popupPage) {
      await waitForReady(popupPage);
      if (
        popupPage.url().startsWith("blob:") ||
        popupPage.url().includes("/view-bill") ||
        popupPage.url().includes("referenceid=")
      ) {
        return {
          page: popupPage,
          cleanup: async () => {
            await popupPage.close().catch(() => {});
          },
        };
      }
    }

    const currentUrl = originalPage.url();
    if (
      currentUrl !== originalUrl &&
      (
        currentUrl.startsWith("blob:") ||
        currentUrl.includes("/view-bill") ||
        currentUrl.includes("referenceid=")
      )
    ) {
      return {
        page: originalPage,
        cleanup: async () => {
          await originalPage.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
          await waitForReady(originalPage);
        },
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return null;
}

async function clickInvoiceAndCaptureRequests(page, rowIndex) {
  return page.evaluate(async (index) => {
    const logs = [];
    const invoiceResponses = [];
    const pending = [];
    const originalFetch = window.fetch;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    const blobToBase64 = (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
        reader.onloadend = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          resolve(result.replace(/^data:.*?;base64,/, ""));
        };
        reader.readAsDataURL(blob);
      });

    window.fetch = async function (...args) {
      try {
        const url = String(args[0]);
        logs.push({ type: "fetch", url });
        const response = await originalFetch.apply(this, args);

        if (/\/billingmgmt\/bill\//i.test(url) || /\/billingmgmt\/bill\//i.test(response.url)) {
          pending.push(
            (async () => {
              const contentType = response.headers.get("content-type") ?? "";
              if (/pdf/i.test(contentType)) {
                const blob = await response.clone().blob();
                invoiceResponses.push({
                  ok: true,
                  contentType,
                  responseUrl: response.url,
                  contentDisposition: response.headers.get("content-disposition"),
                  base64: await blobToBase64(blob),
                });
              } else {
                invoiceResponses.push({
                  ok: false,
                  contentType,
                  responseUrl: response.url,
                  bodyText: (await response.clone().text()).replace(/\s+/g, " ").trim().slice(0, 500),
                });
              }
            })()
          );
        }

        return response;
      } catch {}
      return originalFetch.apply(this, args);
    };

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        this.__cashgrabUrl = String(url);
        logs.push({ type: "xhr", method, url: String(url) });
      } catch {}
      return originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (/\/billingmgmt\/bill\//i.test(this.__cashgrabUrl ?? "")) {
        pending.push(
          new Promise((resolve) => {
            this.addEventListener(
              "loadend",
              async () => {
                try {
                  const contentType = this.getResponseHeader("content-type") ?? "";
                  const responseUrl = this.responseURL ?? this.__cashgrabUrl ?? "";
                  const contentDisposition =
                    this.getResponseHeader("content-disposition") ?? null;

                  if (/pdf/i.test(contentType)) {
                    let blob = null;
                    if (this.response instanceof Blob) {
                      blob = this.response;
                    } else if (this.response instanceof ArrayBuffer) {
                      blob = new Blob([this.response], { type: contentType });
                    }

                    if (blob) {
                      invoiceResponses.push({
                        ok: true,
                        contentType,
                        responseUrl,
                        contentDisposition,
                        base64: await blobToBase64(blob),
                      });
                    } else {
                      invoiceResponses.push({
                        ok: false,
                        contentType,
                        responseUrl,
                        bodyText: "Invoice response was not exposed as a Blob",
                      });
                    }
                  } else {
                    let bodyText = "";
                    if (this.response instanceof Blob) {
                      bodyText = (await this.response.text()).replace(/\s+/g, " ").trim().slice(0, 500);
                    } else if (typeof this.responseText === "string") {
                      bodyText = this.responseText.replace(/\s+/g, " ").trim().slice(0, 500);
                    }

                    invoiceResponses.push({
                      ok: false,
                      contentType,
                      responseUrl,
                      bodyText,
                    });
                  }
                } catch (error) {
                  invoiceResponses.push({
                    ok: false,
                    contentType: "",
                    responseUrl: this.responseURL ?? this.__cashgrabUrl ?? "",
                    bodyText: String(error?.message ?? error),
                  });
                } finally {
                  resolve();
                }
              },
              { once: true }
            );
          })
        );
      }

      return originalXhrSend.apply(this, args);
    };

    try {
      const button = document.querySelectorAll("#previous-invoice .__content button")[index];
      if (!(button instanceof HTMLElement)) {
        throw new Error(`Could not find invoice button for row ${index}`);
      }

      const initialUrl = location.href;
      button.click();

      const deadline = Date.now() + 1500;
      while (
        Date.now() < deadline &&
        invoiceResponses.length === 0 &&
        pending.length === 0 &&
        location.href === initialUrl
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await Promise.allSettled(pending);

      return {
        currentUrl: location.href,
        requests: logs,
        invoiceResponse: invoiceResponses.at(-1) ?? null,
      };
    } finally {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
    }
  }, rowIndex);
}

async function readPdfFromPage(page) {
  const file = await page.evaluate(async () => {
    const toBase64 = async (url) => {
      if (!url) return null;
      const response = await fetch(url, {
        headers: {
          Accept: "application/pdf",
        },
        credentials: "include",
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !/pdf/i.test(contentType)) {
        return null;
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }

      return {
        ok: true,
        status: response.status,
        contentType,
        contentDisposition: response.headers.get("content-disposition"),
        base64: btoa(binary),
      };
    };

    const sources = [
      location.href,
      window.pdfSrc,
      ...Array.from(document.querySelectorAll("embed, iframe, object")).map(
        (element) =>
          element.getAttribute("src") ||
          element.getAttribute("data") ||
          ""
      ),
      ...Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href),
    ]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);

    for (const source of sources) {
      const file = await toBase64(source).catch(() => null);
      if (file) {
        return file;
      }
    }

    return {
      ok: false,
      status: 0,
      contentType: "",
      bodyText: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 500),
      sources: sources.slice(0, 20),
    };
  });

  if (!file.ok) {
    throw new Error(
      `could not locate PDF on invoice page${file.bodyText ? ` (${file.bodyText})` : ""}`
    );
  }

  return file;
}

async function downloadPdfFromUrl(page, url) {
  const file = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      headers: {
        Accept: "application/pdf",
      },
      credentials: "include",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const responseUrl = response.url ?? targetUrl;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        contentType,
        responseUrl,
      };
    }

    if (!/pdf/i.test(contentType)) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        contentType,
        responseUrl,
        bodyText: text.replace(/\s+/g, " ").trim().slice(0, 500),
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return {
      ok: true,
      status: response.status,
      contentType,
      responseUrl,
      contentDisposition: response.headers.get("content-disposition"),
      base64: btoa(binary),
    };
  }, url);

  if (!file.ok) {
    const sessionExpired = isDodoAuthFailure({
      bodyText: file.bodyText ?? "",
    });

    if (sessionExpired) {
      throw new Error(dodoAuthErrorMessage());
    }

    throw new Error(
      `expected PDF response, got "${file.contentType || "unknown"}"${
        file.bodyText ? ` (${file.bodyText})` : ""
      }`
    );
  }

  return file;
}

async function downloadInvoicePdf(browser, page, invoice) {
  const originalUrl = page.url();
  const pagesBefore = await browser.pages();

  const clickResult = await clickInvoiceAndCaptureRequests(page, invoice.index);

  if (clickResult.currentUrl.startsWith(LOGIN_URL)) {
    throw new Error(dodoAuthErrorMessage());
  }

  if (clickResult.invoiceResponse && !clickResult.invoiceResponse.ok) {
    const sessionExpired = isDodoAuthFailure({
      bodyText: clickResult.invoiceResponse.bodyText ?? "",
    });

    if (sessionExpired) {
      throw new Error(dodoAuthErrorMessage());
    }
  }

  const pdfPage = await waitForPdfPage(browser, page, originalUrl);
  if (pdfPage) {
    const file = await readPdfFromPage(pdfPage.page);
    await pdfPage.cleanup();

    const pagesAfter = await browser.pages();
    if (pagesAfter.length !== pagesBefore.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await reopenPreviousInvoicesIfNeeded(page);

    return file;
  }

  if (clickResult.invoiceResponse) {
    if (!clickResult.invoiceResponse.ok) {
      throw new Error(
        `invoice response was not a PDF${
          clickResult.invoiceResponse.bodyText
            ? ` (${clickResult.invoiceResponse.bodyText})`
            : ""
        }`
      );
    }

    await reopenPreviousInvoicesIfNeeded(page);

    return clickResult.invoiceResponse;
  }

  const apiRequest = [...clickResult.requests]
    .reverse()
    .find((request) => /\/billingmgmt\/bill\//i.test(request.url ?? ""));

  if (apiRequest) {
    const file = await downloadPdfFromUrl(page, apiRequest.url);
    await reopenPreviousInvoicesIfNeeded(page);
    return file;
  }

  const loginPage = (await browser.pages()).find((candidate) =>
    candidate.url().startsWith(LOGIN_URL)
  );
  if (loginPage) {
    throw new Error(dodoAuthErrorMessage());
  }

  throw new Error("timed out waiting for invoice PDF page");
}

export async function dodoInvoices(options) {
  const opts = normalizeDodoInvoiceOptions(options);

  const browser = await connectToChrome().catch((error) => {
    console.error("✗ Could not connect to Chrome:", error.message);
    console.error("  Make sure Chrome is running. Try: cashgrab browser");
    process.exit(1);
  });

  const pages = await browser.pages();
  const page = pickDodoPage(pages) ?? (await browser.newPage());

  await waitForReady(page);

  const currentUrl = page.url();
  const pageTitle = await page.title().catch(() => "");

  if (currentUrl.startsWith(LOGIN_URL)) {
    await page
      .goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await browser.disconnect();
    printNotLoggedIn({ currentUrl, pageTitle });
  }

  if (!currentUrl.startsWith(BILLING_URL_PREFIX)) {
    await browser.disconnect();
    printWrongPage({ currentUrl, pageTitle });
  }

  await openPreviousInvoices(page);

  const pageData = await extractInvoices(page);
  const matchingInvoices = pageData.invoices.filter((invoice) => withinRange(invoice, opts));

  if (matchingInvoices.length === 0) {
    console.error(
      `✗ No Dodo invoices found from ${formatDisplayDate(opts.from)} to ${formatDisplayDate(opts.to)}`
    );
    console.error(`  Current URL: ${pageData.currentUrl}`);

    const availableInvoices = pageData.invoices
      .map((invoice) =>
        [invoice.dateText, invoice.invoiceNumber, invoice.amountText]
          .filter(Boolean)
          .join(" | ")
      )
      .filter(Boolean);

    if (availableInvoices.length > 0) {
      console.error("  Available invoices:");
      for (const item of availableInvoices) {
        console.error(`    ${item}`);
      }
    } else if (pageData.bodyText) {
      console.error(`  Page says:   ${pageData.bodyText}`);
    }

    await browser.disconnect();
    process.exit(1);
  }

  console.error(
    `Range:     ${formatDisplayDate(opts.from)} - ${formatDisplayDate(opts.to)}`
  );
  console.error(`Matches:   ${matchingInvoices.length}`);

  for (const invoice of matchingInvoices) {
    const file = await downloadInvoicePdf(browser, page, invoice).catch(async (error) => {
      console.error(
        `✗ Failed to download ${invoice.dateText || invoice.invoiceNumber || "invoice"}: ${error.message}`
      );
      await browser.disconnect();
      process.exit(1);
    });

    const outputFile = join(
      opts.outputDir,
      parseContentDispositionFilename(file.contentDisposition) ?? fallbackFilename(invoice)
    );

    await writeFile(outputFile, Buffer.from(file.base64, "base64"));
    console.error(
      `✓ Saved:   ${invoice.dateText || "-"} | ${invoice.invoiceNumber || "invoice"} -> ${outputFile.split("/").pop()}`
    );
  }

  await browser.disconnect();
}
