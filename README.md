# Torn Blackjack Tracker

A static web page that reads your own Torn blackjack logs through the official
API and shows wins, losses, pushes and profit, broken down by day.

There is no backend. The page is HTML, CSS and one JavaScript file. Your API
key is stored in your browser and sent only to `api.torn.com`.

## Using it

1. Open the page.
2. Paste a Torn API key that can read logs.
3. Press one of the history buttons. Nothing downloads until you ask.

## About the API key

Blackjack history lives in your Torn **logs**. Only two kinds of key reach them:

| Key | Reads |
|---|---|
| Full Access | Your entire account. Don't use one here. |
| Custom, `user -> log` | Logs only. |

Torn's settings page offers four fixed levels and none of them is "logs only",
so a custom key can only be created through a special link. **That link creates
a live key the moment you open it** — no confirmation, and it can't be edited
afterwards, only copied or deleted.

The key it creates reads *all* of your logs, not just blackjack. That includes
trades, money and market activity. It cannot act on your account or spend
anything, but it is a detailed history. It is still much narrower than Full
Access, which is the only alternative that reaches logs at all.

Delete any key from **Settings → API Keys**.

## How the money is calculated

Torn's log fields are not as obvious as they look, and getting this wrong
produces confidently wrong totals.

- `winnings` on a win is **gross** — the stake plus the profit. A 50m bet that
  wins logs `winnings: 100000000`. Summing `winnings` and subtracting `losses`
  gives the wrong sign.
- A **push** returns your stake under the key `money`, not `winnings`. Miss it
  and every push looks like losing the whole bet.
- A **surrender** returns half the stake, also under `money`.
- `losses` duplicates the bet and is ignored entirely.
- **Double down** and **split** each log their extra stake as another `bet`.

So one rule covers everything:

```
net = sum(winnings) + sum(money) - sum(bet)
```

Verified against real hands, including splits, doubles and pushes.

### Counting

A **split counts as two hands**, because Torn emits two outcome events for it —
one deal can be a win and a loss at once.

### The one unresolved thing

An **insurance win** logs `bet: 8500, winnings: 17000`. Under the same rule as
every other payout, that nets +8,500. But insurance is documented as paying
2:1, which would make it +17,000 and leave the hand exactly even — the whole
point of insurance.

Both readings produce the identical logged number, so the log cannot settle it.
The tool uses the consistent reading and **flags these hands** so they're
visible. Insurance only wins when the dealer has blackjack, so it's rare.

To settle it: note your cash before and after one insurance hand. Even means
the tool is understating by half the main bet on those hands.

## Log types (category 191)

| ID | Event | Money field |
|---|---|---|
| 8350 | start | `bet` |
| 8351 | hit | — |
| 8352 | double down | `bet` (the extra stake) |
| 8353 | split | `bet` (the extra stake) |
| 8354 | lose | `losses` (ignored) |
| 8355 | win | `winnings` (gross) |
| 8356 | insurance lose | `bet` |
| 8357 | insurance win | `bet`, `winnings` |
| 8358 | push | `money` (stake returned) |
| 8359 | surrender | `money` (half returned) |

There is no separate type for a natural blackjack — it's an ordinary `8355`
with a larger payout. Standing isn't logged at all.

## Behaviour

- **Read-only.** It calls Torn's log endpoint. It cannot act on your account.
- **60 calls/min**, against Torn's ceiling of 100.
- **On demand.** Nothing is fetched unless you press a button.
- **Cached** in IndexedDB, so a second fetch only grabs what's missing.

## Development

No build step, no dependencies. Edit the files and reload.

```
index.html    markup and all user-facing copy
style.css     styling, light and dark
app.js        config, storage, API, engine, UI
```

Other casino games are separate log categories with the same event shape. The
`GAMES` object at the top of `app.js` is the only game-specific part; adding
roulette or slots means adding an entry there.
