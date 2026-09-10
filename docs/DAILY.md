# Daily local workflow — validating a real edge

This runs the engine on **real book odds** and **real game results** on your own
machine, building a paper-trading journal that **accumulates day over day**. That
— not the demo seed — is what tells you whether the logic has a real edge, before
you ever risk money on a bookie or Kalshi.

> Why not the demo? The self-contained demo's outcomes are generated from our own
> model, so it will always look calibrated and profitable. It proves the engine +
> UI work, not that we beat the market. Only real odds + real outcomes do that.

## One-time setup

1. Install [Node.js](https://nodejs.org) 18+.
2. Get the repo and install deps:
   ```bash
   git clone https://github.com/loadedmoneybags10/kalshi-edge-finder.git
   cd kalshi-edge-finder
   npm install
   ```
3. Have your Odds API key ready (the-odds-api.com).

## Every day — one command

```bash
ODDS_API_KEY=your_key_here npm run daily
```

That single command:
1. **grades** yesterday's finished games from real final scores,
2. **snapshots** closing lines (for CLV),
3. **places** today's confirmed plays from real odds (net-EV gate),
4. rebuilds **`edge/dashboard-local.html`** — open it in your browser to see the
   whole journal (Active, Calendar, Profile, Analytics, Bankroll). No server.
5. writes **`edge/journal-export.json`** — the data file.

The journal lives in `./data/state.json` and **keeps growing** each run — new
plays get added, prior ones settle. Your credit use is tiny (it skips
out-of-season leagues and caches odds).

Tip (Mac/Linux) so you don't paste the key each time:
```bash
export ODDS_API_KEY=your_key_here   # add to ~/.zshrc to make it permanent
npm run daily
```

## Updating the hosted artifact (optional)

If you want the shareable hosted dashboard updated to match your journal:
```bash
git add edge/journal-export.json && git commit -m "journal $(date +%F)" && git push
```
Then tell Claude "pushed" — it pulls `journal-export.json`, bakes it into the
hosted artifact, and republishes to the **same link**. (Or just paste the file
contents into the chat.)

## Reading the result — is the edge real?

After ~2–3 weeks of daily runs, look at **Analytics**:
- **Mean CLV** positive and consistent → the market is moving toward your bets
  after you place them. This is the strongest leading indicator of a real edge.
- **Calibration curve** hugging the diagonal (your 60%s win ~60%) → the fair
  model is honest.
- **Brier / log loss** low and stable.

Positive CLV on a few hundred real plays is the green light to consider real
money. Win rate alone on a small sample is noise — don't trade on it.
