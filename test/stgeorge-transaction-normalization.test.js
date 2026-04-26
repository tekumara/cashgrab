import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStGeorgeTransactionsCsv,
  countCsvRecords,
  deriveStGeorgeNotes,
  deriveStGeorgePayee,
  normalizeStGeorgeDownloadCsv,
} from "../src/stgeorge-transaction-normalization.js";

test("deriveStGeorgePayee and deriveStGeorgeNotes extract supported St.George prefixes", () => {
  const cases = [
    ["Visa Purchase 12APR26 THE GROCER", "THE GROCER", "Visa Purchase"],
    ["Visa Purchase O/Seas 12APR26 AIRBNB", "AIRBNB", "Visa Purchase O/Seas"],
    ["Visa Credit 12APR26 REFUND STORE", "REFUND STORE", "Visa Credit"],
    ["Visa Credit Overseas 12APR26 VAT REFUND", "VAT REFUND", "Visa Credit Overseas"],
    ["Osko Withdrawal N123 JOHN CITIZEN", "JOHN CITIZEN", "Osko Withdrawal"],
    ["Osko Deposit N123 JOHN CITIZEN", "JOHN CITIZEN", "Osko Deposit"],
    ["Sct Deposit N123 PAYROLL PTY LTD", "PAYROLL PTY LTD", "Sct Deposit"],
    ["Eftpos Debit 120426 LOCAL CAFE", "LOCAL CAFE", "Eftpos Debit"],
    ["Eftpos Credit 120426 CASH OUT REVERSAL", "CASH OUT REVERSAL", "Eftpos Credit"],
    ["Tfr Wdl BPAY Internet 998877 ENERGY AUSTRALIA", "ENERGY AUSTRALIA", "Tfr Wdl BPAY Internet"],
    ["Atm Withdrawal 120426 STG ATM SYDNEY", "STG ATM SYDNEY", "Atm Withdrawal"],
    ["Atm Withdrawal -Wbc 120426 WESTPAC ATM", "WESTPAC ATM", "Atm Withdrawal -Wbc"],
    ["Cardless Atm Withdrawal 120426 CARDLESS CASH", "CARDLESS CASH", "Cardless Atm Withdrawal"],
    ["Internet Deposit 120426 SAVINGS TRANSFER", "SAVINGS TRANSFER", "Internet Deposit"],
    ["Internet Withdrawal 120426 RENT PAYMENT", "RENT PAYMENT", "Internet Withdrawal"],
    ["Direct Debit 12345 INSURANCE", "Direct Debit 12345 INSURANCE", ""],
  ];

  for (const [description, expectedPayee, expectedNotes] of cases) {
    assert.equal(deriveStGeorgePayee(description), expectedPayee);
    assert.equal(deriveStGeorgeNotes(description), expectedNotes);
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
    [
      "Date,Description,Payee,Notes,Category,Debit,Credit,Balance",
      '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY","MY SHOP, SYDNEY",Visa Purchase,Shopping,12.34,,100.00',
      "02/04/2026,Internet Withdrawal 120426 RENT PAYMENT,RENT PAYMENT,Internet Withdrawal,Transfers,500.00,,-400.00",
      "",
    ].join("\n")
  );
});

test("normalizeStGeorgeDownloadCsv injects Payee and Notes after Description", () => {
  const input = [
    "Date,Description,Debit,Credit,Balance",
    '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY",12.34,,100.00',
    "02/04/2026,Osko Deposit N123 JOHN CITIZEN,,200.00,300.00",
    "",
  ].join("\r\n");

  const normalized = normalizeStGeorgeDownloadCsv(input);

  assert.equal(
    normalized,
    [
      "Date,Description,Payee,Notes,Debit,Credit,Balance",
      '01/04/2026,"Visa Purchase 12APR26 MY SHOP, SYDNEY","MY SHOP, SYDNEY",Visa Purchase,12.34,,100.00',
      "02/04/2026,Osko Deposit N123 JOHN CITIZEN,JOHN CITIZEN,Osko Deposit,,200.00,300.00",
      "",
    ].join("\n")
  );
  assert.equal(countCsvRecords(normalized), 2);
});

test("normalizeStGeorgeDownloadCsv refreshes existing Payee and Notes columns", () => {
  const input = [
    "Date,Description,Payee,Notes,Debit,Credit,Balance",
    "03/04/2026,Atm Withdrawal -Wbc 120426 WESTPAC ATM,stale payee,stale notes,40.00,,260.00",
    "",
  ].join("\n");

  assert.equal(
    normalizeStGeorgeDownloadCsv(input),
    [
      "Date,Description,Payee,Notes,Debit,Credit,Balance",
      "03/04/2026,Atm Withdrawal -Wbc 120426 WESTPAC ATM,WESTPAC ATM,Atm Withdrawal -Wbc,40.00,,260.00",
      "",
    ].join("\n")
  );
});
