const NOTES_PREFIX_PATTERN = /^(?:Visa Purchase(?: O\/Seas)?|Visa Credit(?: Overseas)?|Osko Withdrawal|Osko Deposit|Sct Deposit|Eftpos Debit|Eftpos Credit|Tfr Wdl BPAY Internet|(?:Cardless )?Atm Withdrawal(?: -Wbc)?|Internet Deposit|Internet Withdrawal)/;
const PAYEE_PREFIX_PATTERN = new RegExp(`${NOTES_PREFIX_PATTERN.source}\\s+\\S+\\s`);

function normalizeDescriptionText(description) {
  return String(description ?? "").replace(/\s+/g, " ").trim();
}

export function deriveStGeorgePayee(description) {
  const text = normalizeDescriptionText(description);
  return text.replace(PAYEE_PREFIX_PATTERN, "").trim();
}

export function deriveStGeorgeNotes(description) {
  const text = normalizeDescriptionText(description);
  return text.match(NOTES_PREFIX_PATTERN)?.[0] ?? "";
}

function parseCsv(content) {
  const text = String(content ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.some((cell) => cell !== ""));
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCsv(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function normalizeHeaderName(header) {
  return String(header ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
}

function findHeaderIndex(headers, expectedName) {
  const normalizedExpected = expectedName.toLowerCase();
  return headers.findIndex((header) => normalizeHeaderName(header) === normalizedExpected);
}

export function countCsvRecords(content) {
  return Math.max(0, parseCsv(content).length - 1);
}

export function buildStGeorgeTransactionsCsv(rows) {
  const headers = ["Date", "Description", "Payee", "Notes", "Category", "Debit", "Credit", "Balance"];
  return serializeCsv([
    headers,
    ...rows.map((row) => [
      row.date,
      row.description,
      deriveStGeorgePayee(row.description),
      deriveStGeorgeNotes(row.description),
      row.category,
      row.debit,
      row.credit,
      row.balance,
    ]),
  ]);
}

export function normalizeStGeorgeDownloadCsv(content) {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return String(content ?? "");
  }

  const [headers, ...dataRows] = rows;
  const descriptionIndex = findHeaderIndex(headers, "Description");
  if (descriptionIndex === -1) {
    return String(content ?? "");
  }

  const keptColumns = headers
    .map((header, index) => ({
      header,
      index,
      normalizedName: normalizeHeaderName(header),
    }))
    .filter(
      (column) => column.normalizedName !== "payee" && column.normalizedName !== "notes"
    );

  const normalizedHeaders = [];
  for (const column of keptColumns) {
    normalizedHeaders.push(column.header);
    if (column.normalizedName === "description") {
      normalizedHeaders.push("Payee", "Notes");
    }
  }

  const normalizedRows = dataRows.map((row) => {
    const normalizedRow = [];

    for (const column of keptColumns) {
      const value = row[column.index] ?? "";
      normalizedRow.push(value);

      if (column.normalizedName === "description") {
        normalizedRow.push(deriveStGeorgePayee(value), deriveStGeorgeNotes(value));
      }
    }

    return normalizedRow;
  });

  return serializeCsv([normalizedHeaders, ...normalizedRows]);
}
