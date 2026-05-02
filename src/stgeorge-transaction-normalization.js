const NOTES_PREFIX_PATTERN = /^(?:Visa Purchase(?: O\/Seas)?|Visa Credit(?: Overseas)?|Osko Withdrawal|Osko Deposit|Sct Deposit|Eftpos Debit|Eftpos Credit|Tfr Wdl BPAY Internet|(?:Cardless )?Atm Withdrawal(?: -Wbc)?|Internet Deposit|Internet Withdrawal)/;
const PAYEE_PREFIX_PATTERN = new RegExp(`${NOTES_PREFIX_PATTERN.source}\\s+\\S+\\s`);
const DERIVED_COLUMNS = [
  { header: "Payee", key: "payee" },
  { header: "Notes", key: "notes" },
];
const REPLACED_COLUMN_NAMES = new Set(["payee", "notes"]);

// St.George descriptions often use padded spacing for visual alignment.
// Normalize whitespace before deriving fields so Payee/Notes are emitted in a
// stable, cleaned form rather than preserving those alignment spaces.
function normalizeDescriptionText(description) {
  return String(description ?? "").replace(/\s+/g, " ").trim();
}

function deriveStGeorgeFields(description) {
  const text = normalizeDescriptionText(description);

  return {
    payee: text.replace(PAYEE_PREFIX_PATTERN, "").trim(),
    notes: text.match(NOTES_PREFIX_PATTERN)?.[0] ?? "",
  };
}

export function deriveStGeorgePayee(description) {
  return deriveStGeorgeFields(description).payee;
}

export function deriveStGeorgeNotes(description) {
  return deriveStGeorgeFields(description).notes;
}

function parseCsv(content) {
  const text = String(content ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const finishRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };

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

    switch (char) {
      case '"':
        inQuotes = true;
        break;
      case ",":
        row.push(field);
        field = "";
        break;
      case "\r":
        if (text[index + 1] === "\n") {
          index += 1;
        }
        finishRow();
        break;
      case "\n":
        finishRow();
        break;
      default:
        field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    finishRow();
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

export function countCsvRecords(content) {
  return Math.max(0, parseCsv(content).length - 1);
}

export function normalizeStGeorgeDownloadCsv(content) {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return String(content ?? "");
  }

  const [headers, ...dataRows] = rows;
  const sourceColumns = headers.map((header, index) => ({
    header,
    index,
    name: normalizeHeaderName(header),
  }));
  const descriptionColumn = sourceColumns.find((column) => column.name === "description");

  if (!descriptionColumn) {
    return String(content ?? "");
  }

  const outputColumns = [];
  for (const column of sourceColumns) {
    if (REPLACED_COLUMN_NAMES.has(column.name)) {
      continue;
    }

    outputColumns.push(column);
    if (column.name === "description") {
      outputColumns.push(...DERIVED_COLUMNS);
    }
  }

  const normalizedRows = dataRows.map((row) => {
    const { payee, notes } = deriveStGeorgeFields(row[descriptionColumn.index] ?? "");

    return outputColumns.map((column) => {
      if (column.key === "payee") return payee;
      if (column.key === "notes") return notes;
      return row[column.index] ?? "";
    });
  });

  return serializeCsv([
    outputColumns.map((column) => column.header),
    ...normalizedRows,
  ]);
}
