# cashgrab

`cashgrab` is a local CLI for browser-driven banking workflows.

Today it does three things:

- Starts a dedicated Chrome instance with remote debugging enabled for scraping flows.
- Reads Bankwest account balances from an authenticated Bankwest session.
- Exports Bankwest transactions as QIF files for downstream import into budgeting tools.

The repo also contains bank-specific cleaning helpers for imported transaction files.

## Bankwest

Automates Bankwest Online Banking via Chrome DevTools Protocol (CDP). Everything goes through the `cashgrab` CLI.

Install dependencies and expose the local CLI:

```bash
npm install
npm link
```

Requires Chrome running with remote debugging on port `9222` and logged in to Bankwest.

Start Chrome:

```bash
cashgrab browser
```

This launches a separate Chrome instance with its own profile directory (`~/.cache/browser-tools`). If Chrome is already running on `:9222`, it exits immediately.

Use `--profile` to copy your existing Chrome profile (cookies, logins) into the separate Chrome instance first.

```bash
cashgrab browser --profile
```

### Account Balances

Prints all account balances grouped by category.

Navigates to the Bankwest Account Balances page automatically. If Bankwest redirects away from that page, the session is not logged in.

```bash
cashgrab bankwest balances
```

Example output:

```text
❯ cashgrab bankwest balances

Bankwest Account Balances - MR SMITH
As at: 29/03/2026 5:48 EDT

Transaction Accounts
────────────────────────────────────────────────────────────────────────
Nickname                   Account Number     Current Balance    Available Balance
────────────────────────────────────────────────────────────────────────
Offset Joint               123-456 7890123    $1,234.56          $1,234.56
Offset Jane                123-456 7890456    $2,345.67          $2,345.67
Offset John                123-456 7890789    $3,456.78          $3,456.78
...
```

### Transaction Export

Exports transactions as a QIF file (MS Money format).

Navigates to the transaction search page automatically. The account name is a case-insensitive substring match against the Bankwest dropdown options — it must match exactly one account, otherwise available options are listed.

```text
❯ cashgrab bankwest transactions --help
Usage: cashgrab bankwest transactions [options] <accountName...>

Arguments:
  accountName           Case-insensitive substring match against the Bankwest
                        account dropdown

Options:
  -r, --range <preset>  Date range preset: L7Days, L14Days, L30Days, L60Days,
                        L90Days, LMONTH, SLMONTH, TLMONTH (default: "L30Days")
  --from <date>         Custom start date (DD/MM/YYYY), requires --to
  --to <date>           Custom end date (DD/MM/YYYY or "today"), requires --from
  -o, --output <dir>    Output directory for the exported file
  -h, --help            display help for command
```

Examples:

```bash
cashgrab bankwest transactions "offset joint" -r L30Days
cashgrab bankwest transactions "home loan john" -r L90Days -o ~/Downloads
cashgrab bankwest transactions "offset joint" --from 01/01/2026 --to 28/03/2026
```

## Cleaning

Cleaning transactions before importing them:

- [St George](src/stg) - download as CSV
- [NAB](src/nab) - download as QIF
