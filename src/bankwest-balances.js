/**
 * Bankwest Account Balances
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * navigates to the Bankwest balances page,
 * then prints all accounts and their balances.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to Bankwest Online Banking
 */
import { connectToChrome } from "./connect-browser.js";

const BALANCES_URL =
  "https://online.bankwest.com.au/CMWeb/AccountInformation/AI/Balances.aspx";
const LOGIN_URL = "https://online.bankwest.com.au/Session/PersonalLogin";
const EXPECTED_URL_PATTERN = /online\.bankwest\.com\.au\/CMWeb\/AccountInformation\/AI\/Balances\.aspx/;
export async function bankwestBalances() {
  const browser = await connectToChrome().catch((e) => {
    console.error("✗ Could not connect to Chrome:", e.message);
    console.error("  Make sure Chrome is running. Try: cashgrab browser");
    process.exit(1);
  });

  const page = (await browser.pages()).at(-1) ?? await browser.newPage();

  // Navigate to the balances page and let Bankwest redirect if the session is not logged in.
  await page.goto(BALANCES_URL, { waitUntil: "domcontentloaded", timeout: 15000 });

  const currentUrl = page.url();
  if (!EXPECTED_URL_PATTERN.test(currentUrl)) {
    await page
      .goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 })
      .catch(() => {});
    console.error("✗ Not logged in. Expected Bankwest Account Balances page.");
    console.error(`  Current URL: ${currentUrl}`);
    console.error(`  Expected:    ${BALANCES_URL}`);
    console.error(`  Opened:      ${LOGIN_URL}`);
    console.error("  Log in to Bankwest Online Banking first.");
    await browser.disconnect();
    process.exit(1);
  }

  // Extract Bankwest's page state from the balances view.
  const data = await page.evaluate(() => {
    if (typeof ContainerContext === "undefined" || !ContainerContext?.accountBalancesContext) {
      throw new Error("ContainerContext not found - page may not have loaded correctly");
    }
    return {
      customerName: ContainerContext.customerName,
      asAt: ContainerContext.accountBalancesContext.AsAtDateTime,
      balances: ContainerContext.accountBalancesContext.Balances,
      netBalances: ContainerContext.accountBalancesContext.NetBalances,
    };
  });

  await browser.disconnect();

  const fmt = (n) =>
    new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

  const pad = (s, n) => String(s).padEnd(n);

  console.log(`\nBankwest Account Balances - ${data.customerName}`);
  console.log(`As at: ${data.asAt}\n`);

  // Group accounts by Bankwest category before printing.
  const groups = {};
  for (const acct of data.balances) {
    const cat = acct.AccountCategoryCode ?? "OTHER";
    (groups[cat] ??= []).push(acct);
  }

  const categoryLabels = {
    TRANSACCTS: "Transaction Accounts",
    MORTGAGE: "Home Loans",
    CREDITCARDS: "Credit Cards",
    OTHER: "Other",
  };

  for (const [cat, accounts] of Object.entries(groups)) {
    console.log(`${categoryLabels[cat] ?? cat}`);
    console.log("─".repeat(72));
    console.log(
      `${pad("Nickname", 26)} ${pad("Account Number", 18)} ${pad("Current Balance", 18)} Available Balance`
    );
    console.log("─".repeat(72));

    for (const account of accounts) {
      const nickname = account.AccountNickName || account.AccountName;
      console.log(
        `${pad(nickname, 26)} ${pad(account.AccountNumber, 18)} ${pad(fmt(account.AccountCurrentBalance), 18)} ${fmt(account.AccountAvailableBalance)}`
      );
    }
    console.log();
  }

  // Print the overall net balance summary shown by Bankwest.
  console.log("─".repeat(72));
  console.log("Summary");
  console.log("─".repeat(72));
  for (const net of data.netBalances) {
    console.log(`${pad(net.title, 20)} ${fmt(net.value)}`);
  }
  console.log();
}
