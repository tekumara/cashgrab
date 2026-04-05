# cashgrab

`cashgrab` is a local CLI that scrapes banking websites via Chrome DevTools Protocol (CDP). It launches a dedicated Chrome instance, connects over remote debugging, and automates authenticated sessions to pull account data. It never sees your credentials - these stay within the Browser.

Supported banks:

- **Bankwest** -- account balances and transaction export (QIF)
- **St.George** -- account balances and transaction export (CSV)

The repo also includes shell scripts for cleaning exported transaction files before import.

## Install

```bash
npm install -g cashgrab
```

## Browser

All scraping commands require Chrome running with remote debugging on port `9222`. Use `--profile` to copy your existing Chrome profile (cookies, logins) into the dedicated instance first.

```bash
cashgrab browser
cashgrab browser --profile
```

The browser launches with its own profile directory (`~/.cache/browser-tools`). If Chrome is already running on `:9222`, the command exits immediately.

## Bankwest

Requires a logged-in Bankwest session.

### Account Balances

```bash
cashgrab bankwest balances
```

### Transaction Export

Exports transactions as a QIF file. The account name is a case-insensitive substring match against the Bankwest dropdown -- it must match exactly one account, otherwise available options are listed.

```bash
cashgrab bankwest transactions "offset joint" -r L30Days
cashgrab bankwest transactions "home loan john" -r L90Days -o ~/Downloads
cashgrab bankwest transactions "offset joint" --from 01/01/2026 --to 28/03/2026
cashgrab bankwest transactions "offset joint" --from 2026-01-01 --to 2026-03-28
```

## St.George

Requires a logged-in St.George session.

### Account Balances

```bash
cashgrab st-george balances
```

### Transaction Export

Exports transactions as a CSV file. The account name is a case-insensitive substring match against the portfolio accounts.

```bash
cashgrab st-george transactions "000 111 222" -r L7Days
cashgrab st-george transactions "residential loan s000 111 222 333" -r L30Days -o ~/Downloads
cashgrab st-george transactions "complete freedom offset 000 111 222" --from 01/03/2026 --to 29/03/2026
cashgrab st-george transactions "complete freedom offset 000 111 222" --from 2026-03-01 --to 2026-03-29
```

## Cleaning

- [St George](src/stg) -- CSV cleaning
- [NAB](src/nab) -- QIF cleaning
