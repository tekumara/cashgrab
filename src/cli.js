#!/usr/bin/env node

import { Command } from "commander";
import { startBrowser } from "./browser-start.js";
import { asbBalances } from "./asb-balances.js";
import { asbStatements } from "./asb-statements.js";
import { bankwestBalances } from "./bankwest-balances.js";
import { dodoInvoices } from "./dodo-invoices.js";
import {
	bankwestTransactions,
	normalizeTransactionOptions,
} from "./bankwest-transactions.js";
import { normalizeDateInput } from "./date-input.js";
import { stGeorgeBalances } from "./stgeorge-balances.js";
import {
	normalizeStGeorgeTransactionOptions,
	stGeorgeTransactions,
} from "./stgeorge-transactions.js";

const program = new Command();

function isCliDateToken(value) {
	if (!value) return false;
	if (value === "today") return true;
	return /^\d{2}\/\d{2}\/\d{4}$/.test(normalizeDateInput(value));
}

program
	.name("cashgrab")
	.description("Browser automation helpers for cashgrab")
	.showHelpAfterError("(add --help for usage details)");

program
	.command("browser")
	.description("Start Chrome with remote debugging on :9222")
	.option("--profile", "Copy your default Chrome profile (cookies, logins)")
	.action(async (options) => {
		await startBrowser({ profile: options.profile });
	});

const bankwest = program
	.command("bankwest")
	.description("Bankwest scraping commands");

const asb = program
	.command("asb")
	.description("ASB scraping commands");

const dodo = program
	.command("dodo")
	.description("Dodo scraping commands");

asb
	.command("balances")
	.description("Print balances from the active ASB balances page")
	.action(async () => {
		await asbBalances();
	});

asb
	.command("statements")
	.description("Download ASB statement PDFs from the Document Centre")
	.argument(
		"[query...]",
		"Optional case-insensitive match against account number, account name, or statement type",
	)
	.option("--date <date>", "Exact statement date")
	.option("--from <date>", "Range start date (requires --to)")
	.option("--to <date>", "Range end date (requires --from)")
	.option("-o, --output <dir>", "Output directory for the downloaded file")
	.action(async (query, options) => {
		const tokens = query ?? [];

		if (!(options.date || options.from || options.to)) {
			const positionalDates = tokens.filter(isCliDateToken);
			if (positionalDates.length > 0) {
				console.error("✗ Use --date <date> or --from <date> --to <date>");
				process.exit(1);
			}
		}

		await asbStatements({
			date: options.date,
			from: options.from,
			to: options.to,
			accountQuery: tokens.join(" "),
			outputDir: options.output,
		});
	});

bankwest
	.command("balances")
	.description("Print balances from the active Bankwest balances tab")
	.action(async () => {
		await bankwestBalances();
	});

bankwest
	.command("transactions")
	.description("Export transactions as a QIF file")
	.argument(
		"<accountName...>",
		"Case-insensitive substring match against the Bankwest account dropdown",
	)
	.option(
		"-r, --range <preset>",
		"Date range preset: L7Days, L14Days, L30Days, L60Days, L90Days, LMONTH, SLMONTH, TLMONTH",
		"L30Days",
	)
	.option("--from <date>", "Custom start date (DD/MM/YYYY or YYYY-MM-DD), requires --to")
	.option(
		"--to <date>",
		'Custom end date (DD/MM/YYYY, YYYY-MM-DD, or "today"), requires --from',
	)
	.option("-o, --output <dir>", "Output directory for the exported file")
	.action(async (accountName, options) => {
		await bankwestTransactions(
			normalizeTransactionOptions({
				accountQuery: accountName.join(" "),
				range: options.range,
				from: options.from,
				to: options.to,
				outputDir: options.output,
			}),
		);
	});

const stGeorge = program
	.command("st-george")
	.alias("stgeorge")
	.description("St.George scraping commands");

stGeorge
	.command("balances")
	.description("Print balances from the St.George account portfolio page")
	.action(async () => {
		await stGeorgeBalances();
	});

stGeorge
	.command("transactions")
	.description("Export transactions as a CSV file")
	.argument(
		"<accountName...>",
		"Case-insensitive substring match against account name, account number, or BSB",
	)
	.option(
		"-r, --range <preset>",
		"Date range preset: L7Days, L30Days",
		"L30Days",
	)
	.option("--date <date>", "Single transaction date (DD/MM/YYYY, DD-MM-YYYY, or YYYY-MM-DD)")
	.option("--from <date>", "Custom start date (DD/MM/YYYY or YYYY-MM-DD), requires --to")
	.option(
		"--to <date>",
		'Custom end date (DD/MM/YYYY, YYYY-MM-DD, or "today"), requires --from',
	)
	.option("-o, --output <dir>", "Output directory for the exported file")
	.action(async (accountName, options) => {
		await stGeorgeTransactions(
			normalizeStGeorgeTransactionOptions({
				accountQuery: accountName.join(" "),
				range: options.range,
				date: options.date,
				from: options.from,
				to: options.to,
				outputDir: options.output,
			}),
		);
	});

dodo
	.command("invoices")
	.description("Download invoice PDFs from the open Dodo billing overview service page")
	.option("--date <date>", "Exact invoice date")
	.option("--from <date>", "Range start date (requires --to)")
	.option("--to <date>", "Range end date (requires --from)")
	.option("-o, --output <dir>", "Output directory for the downloaded files")
	.action(async (options) => {
		await dodoInvoices({
			date: options.date,
			from: options.from,
			to: options.to,
			outputDir: options.output,
		});
	});

await program.parseAsync(process.argv);
