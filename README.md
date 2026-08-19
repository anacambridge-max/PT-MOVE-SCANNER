# PT Move Scanner — Upstox

Fresh Next.js dashboard for the exact scanner shown in the Chartink screenshot.

## Scanner logic

All conditions are required:

1. **Futures segment:** `5 minute Volume > 5 minute SMA(Volume,20) × 2`
2. **Cash segment:** `5 minute High > 1 day ago High` **OR** `5 minute Low < 1 day ago Low`
3. **Daily High:** `Daily High > 50`

The universe is the current nearest non-expired NSE stock-futures contract, matched to its NSE cash/underlying instrument.

No CPR, NR4/NR7, moving averages, RSI, or extra signal filters are included.

## Upstox setup

Use an Upstox **Analytics Token** for this read-only scanner and add it to Vercel as:

`UPSTOX_ANALYTICS_TOKEN`

The code also accepts `UPSTOX_ACCESS_TOKEN` as a fallback.

Never commit a real token to GitHub.

## Local run

```bash
npm install
npm run dev
```

Then open the local Next.js URL.

## Vercel

Import this GitHub repository into a **new Vercel project** and add the environment variable above for Production and Preview as needed.

The scanner uses Upstox V3 5-minute intraday/historical candles and V3 daily OHLC, while market quotes are batched through the Upstox quote API.
