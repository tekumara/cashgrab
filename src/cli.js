#!/usr/bin/env node

import { Command } from "commander";
import { startBrowser } from "./browser-start.js";
import { bankwestBalances } from "./bankwest-balances.js";
import {
	bankwestTransactions,
	normalizeTransactionOptions,
} from "./bankwest-transactions.js";
import { stGeorgeBalances } from "./stgeorge-balances.js";
import {
	normalizeStGeorgeTransactionOptions,
	stGeorgeTransactions,
} from "./stgeorge-transactions.js";

const program = new Command();

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
	.option("--from <date>", "Custom start date (DD/MM/YYYY), requires --to")
	.option(
		"--to <date>",
		'Custom end date (DD/MM/YYYY or "today"), requires --from',
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
		"Case-insensitive substring match against the St.George portfolio accounts",
	)
	.option(
		"-r, --range <preset>",
		"Date range preset: L7Days, L30Days",
		"L30Days",
	)
	.option("--from <date>", "Custom start date (DD/MM/YYYY), requires --to")
	.option(
		"--to <date>",
		'Custom end date (DD/MM/YYYY or "today"), requires --from',
	)
	.option("-o, --output <dir>", "Output directory for the exported file")
	.action(async (accountName, options) => {
		await stGeorgeTransactions(
			normalizeStGeorgeTransactionOptions({
				accountQuery: accountName.join(" "),
				range: options.range,
				from: options.from,
				to: options.to,
				outputDir: options.output,
			}),
		);
	});

await program.parseAsync(process.argv);
