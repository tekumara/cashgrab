import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStGeorgeTransactionsCsv,
  countCsvRecords,
  deriveStGeorgeNotes,
  deriveStGeorgePayee,
  normalizeStGeorgeDownloadCsv,
} from "../src/stgeorge-transaction-normalization.js";

function buildCsv(lines, newline = "\n") {
  return `${lines.join(newline)}${newline}`;
}

test("deriveStGeorgePayee and deriveStGeorgeNotes extract supported St.George prefixes", () => {
  const cases = [
    {
      description: "Visa Purchase 12APR26 THE GROCER",
      payee: "THE GROCER",
      notes: "Visa Purchase",
    },
    {
      description: "Visa Purchase O/Seas 12APR26 AIRBNB",
      payee: "AIRBNB",
      notes: "Visa Purchase O/Seas",
    },
    {
      description: "Visa Credit 12APR26 REFUND STORE",
      payee: "REFUND STORE",
      notes: "Visa Credit",
    },
    {
      description: "Visa Credit Overseas 12APR26 VAT REFUND",
      payee: "VAT REFUND",
      notes: "Visa Credit Overseas",
    },
    {
      description: "Osko Withdrawal N123 JOHN CITIZEN",
      payee: "JOHN CITIZEN",
      notes: "Osko Withdrawal",
    },
    {
      description: "Osko Deposit N123 JOHN CITIZEN",
      payee: "JOHN CITIZEN",
      notes: "Osko Deposit",
    },
    {
      description: "Sct Deposit N123 PAYROLL PTY LTD",
      payee: "PAYROLL PTY LTD",
      notes: "Sct Deposit",
    },
    {
      description: "Eftpos Debit 120426 LOCAL CAFE",
      payee: "LOCAL CAFE",
      notes: "Eftpos Debit",
    },
    {
      description: "Eftpos Credit 120426 CASH OUT REVERSAL",
      payee: "CASH OUT REVERSAL",
      notes: "Eftpos Credit",
    },
    {
      description: "Tfr Wdl BPAY Internet 998877 ENERGY AUSTRALIA",
      payee: "ENERGY AUSTRALIA",
      notes: "Tfr Wdl BPAY Internet",
    },
    {
      description: "Atm Withdrawal 120426 STG ATM SYDNEY",
      payee: "STG ATM SYDNEY",
      notes: "Atm Withdrawal",
    },
    {
      description: "Atm Withdrawal -Wbc 120426 WESTPAC ATM",
      payee: "WESTPAC ATM",
      notes: "Atm Withdrawal -Wbc",
    },
    {
      description: "Cardless Atm Withdrawal 120426 CARDLESS CASH",
      payee: "CARDLESS CASH",
      notes: "Cardless Atm Withdrawal",
    },
    {
      description: "Internet Deposit 120426 SAVINGS TRANSFER",
      payee: "SAVINGS TRANSFER",
      notes: "Internet Deposit",
    },
    {
      description: "Internet Withdrawal 120426 RENT PAYMENT",
      payee: "RENT PAYMENT",
      notes: "Internet Withdrawal",
    },
    {
      description: "Direct Debit 12345 INSURANCE",
      payee: "Direct Debit 12345 INSURANCE",
      notes: "",
    },
  ];

  for (const { description, payee, notes } of cases) {
    assert.equal(deriveStGeorgePayee(description), payee);
    assert.equal(deriveStGeorgeNotes(description), notes);
  }
});

test("buildStGeorgeTransactionsCsv includes derived Payee and Notes columns", () => {
  const csv = buildStGeorgeTransactionsCsv([
    {
      date: "01/04/2026",
      description: "Visa Purchase 12APR26 MY SHOP, SYDNEY",
      category: "Shopping",
      debit: "12.34",
      credit: "",
      balance: "100.00",
    },
    {
      date: "02/04/2026",
      description: "Internet Withdrawal 120426 RENT PAYMENT",
      category: "Transfers",
      debit: "500.00",
      credit: "",
      balance: "-400.00",
    },
  ]);

  assert.equal(
    csv,
    buildCsv([
      "Date,Description,Payee,Notes,Category,Debit,Credit,Balance",
      '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY","MY SHOP, SYDNEY",Visa Purchase,Shopping,12.34,,100.00',
      "02/04/2026,Internet Withdrawal 120426 RENT PAYMENT,RENT PAYMENT,Internet Withdrawal,Transfers,500.00,,-400.00",
    ])
  );
});

test("deriveStGeorgePayee normalizes padded whitespace in descriptions", () => {
  assert.equal(
    deriveStGeorgePayee(
      "Eftpos Debit                  REF123 Anon                Merchant 01 AU"
    ),
    "Anon Merchant 01 AU"
  );
});

test("normalizeStGeorgeDownloadCsv injects Payee and Notes after Description", () => {
  const input = buildCsv(
    [
      "Date,Description,Debit,Credit,Balance",
      '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY",12.34,,100.00',
      "02/04/2026,Osko Deposit N123 JOHN CITIZEN,,200.00,300.00",
    ],
    "\r\n"
  );

  const normalized = normalizeStGeorgeDownloadCsv(input);

  assert.equal(
    normalized,
    buildCsv([
      "Date,Description,Payee,Notes,Debit,Credit,Balance",
      '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY","MY SHOP, SYDNEY",Visa Purchase,12.34,,100.00',
      "02/04/2026,Osko Deposit N123 JOHN CITIZEN,JOHN CITIZEN,Osko Deposit,,200.00,300.00",
    ])
  );
  assert.equal(countCsvRecords(normalized), 2);
});

test("normalizeStGeorgeDownloadCsv refreshes existing Payee and Notes columns", () => {
  const input = buildCsv([
    "Date,Description,Payee,Notes,Debit,Credit,Balance",
    "03/04/2026,Atm Withdrawal -Wbc 120426 WESTPAC ATM,stale payee,stale notes,40.00,,260.00",
  ]);

  assert.equal(
    normalizeStGeorgeDownloadCsv(input),
    buildCsv([
      "Date,Description,Payee,Notes,Debit,Credit,Balance",
      "03/04/2026,Atm Withdrawal -Wbc 120426 WESTPAC ATM,WESTPAC ATM,Atm Withdrawal -Wbc,40.00,,260.00",
    ])
  );
});
