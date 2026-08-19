import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration = 60

const V2 = 'https://api.upstox.com/v2'
const V3 = 'https://api.upstox.com/v3'
const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY = 20
const TOP = 100
const MULTIPLIER = 2

type Instrument = { instrument_key: string; trading_symbol?: string; name?: string; segment?: string; instrument_type?: string; underlying_symbol?: string; underlying_key?: string; underlying_type?: string; expiry?: number | string }
type Quote = { instrument_token?: string; symbol?: string; last_price?: number; volume?: number; net_change?: number; ohlc?: { open?: number; high?: number; low?: number; close?: number } }
type Candle = [string, number, number, number, number, number, number]

const norm = (value?: string | null) => (value ?? '').trim().toUpperCase().replace(/[|:]/g, '')
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0

function istDate(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const y = Number(p.find(x => x.type === 'year')!.value), m = Number(p.find(x => x.type === 'month')!.value), d = Number(p.find(x => x.type === 'day')!.value)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}
const dayOf = (c: Candle) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(c[0]))
const timeOf = (c: Candle) => new Date(c[0]).getTime()

function expiryDate(value?: number | string) {
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '' }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10)
  return ''
}

async function upstox(url: string, token: string, label: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (response.ok) return response.json()
    if (response.status !== 429) throw new Error(`${label} failed: ${response.status}`)
    await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
  }
  throw new Error(`${label} failed: rate limited`)
}

async function parallel<T, R>(items: T[], worker: (item: T) => Promise<R>) {
  const result: R[] = new Array(items.length); let cursor = 0
  async function runner() { while (true) { const i = cursor++; if (i >= items.length) return; result[i] = await worker(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner)); return result
}

async function loadMaster() {
  const response = await fetch(MASTER, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Upstox instrument master failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  let json = ''; try { json = gunzipSync(bytes).toString('utf8') } catch { json = bytes.toString('utf8') }
  return JSON.parse(json) as Instrument[]
}

async function getQuotes(keys: string[], token: string) {
  const byKey = new Map<string, Quote>(), bySymbol = new Map<string, Quote>()
  for (let i = 0; i < keys.length; i += 500) {
    const url = new URL(`${V2}/market-quote/quotes`); url.searchParams.set('instrument_key', keys.slice(i, i + 500).join(','))
    const data = (await upstox(url.toString(), token, 'Market quotes')).data ?? {}
    for (const [responseKey, raw] of Object.entries(data) as [string, Quote][]) {
      const quote = raw ?? {}
      if (quote.instrument_token) byKey.set(norm(quote.instrument_token), quote)
      byKey.set(norm(responseKey), quote)
      if (quote.symbol) bySymbol.set(quote.symbol.toUpperCase(), quote)
    }
  }
  return { byKey, bySymbol }
}

async function getIntraday5m(key: string, token: string) {
  const data = await upstox(`${V3}/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`, token, '5M intraday')
  return (data.data?.candles ?? []) as Candle[]
}

async function getPreviousDaily(key: string, token: string) {
  const today = istDate()
  const data = await upstox(`${V3}/historical-candle/${encodeURIComponent(key)}/days/1/${today}/${istDate(-10)}`, token, 'Daily history')
  const candles = (data.data?.candles ?? []) as Candle[]
  return candles.filter(c => dayOf(c) < today).sort((a, b) => timeOf(b) - timeOf(a))[0] ?? null
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN
  if (!token) return NextResponse.json({ ok: false, error: 'Upstox token is not configured.' }, { status: 500 })

  try {
    const today = istDate(), instruments = await loadMaster()
    const futures = instruments.filter(item => item.segment === 'NSE_FO' && item.instrument_type === 'FUT' && item.underlying_type === 'EQUITY' && item.underlying_key && item.underlying_symbol && expiryDate(item.expiry) >= today)
    const nearestExpiry = [...new Set(futures.map(x => expiryDate(x.expiry)).filter(Boolean))].sort()[0]
    const bySymbol = new Map<string, Instrument>()
    for (const future of futures.filter(x => expiryDate(x.expiry) === nearestExpiry)) bySymbol.set(future.underlying_symbol!.toUpperCase(), future)
    const universe = [...bySymbol.values()]
    if (!universe.length) throw new Error('NSE F&O universe is empty')

    const diagnostics = { universe: universe.length, quoteMatched: 0, futuresBars: 0, cashBars: 0, dailyHighPass: 0, cashBreakoutPass: 0, volumePass: 0, finalPass: 0, errors: 0 }
    const cashQuotes = await getQuotes(universe.map(x => x.underlying_key!), token)
    const futureQuotes = await getQuotes(universe.map(x => x.instrument_key), token)
    const matched = universe.map(item => ({
      item,
      cashQuote: cashQuotes.byKey.get(norm(item.underlying_key)) ?? cashQuotes.bySymbol.get(item.underlying_symbol!.toUpperCase()),
      futureQuote: futureQuotes.byKey.get(norm(item.instrument_key)),
    })).filter(x => x.cashQuote?.last_price && x.futureQuote?.last_price)
    diagnostics.quoteMatched = matched.length

    // The screenshot uses [-1] 5-minute fields. That means the last COMPLETED 5-minute candle,
    // not the currently-forming candle. SMA(20) is evaluated at that same -1 offset.
    const volumeRows = await parallel(matched, async ({ item, cashQuote, futureQuote }) => {
      try {
        const bars = (await getIntraday5m(item.instrument_key, token)).filter(c => dayOf(c) === today).sort((a, b) => timeOf(a) - timeOf(b))
        diagnostics.futuresBars += bars.length
        if (bars.length < 21) return null
        const signal = bars[bars.length - 2]
        const window = bars.slice(bars.length - 21, bars.length - 1).map(c => Number(c[5]) || 0)
        const sma20 = avg(window), volume = Number(signal[5]) || 0
        if (!(sma20 > 0 && volume > sma20 * MULTIPLIER)) return null
        diagnostics.volumePass++
        return { item, cashQuote, futureQuote, signal, sma20, volume }
      } catch { diagnostics.errors++; return null }
    })
    const volumeCandidates = volumeRows.filter(Boolean) as Array<{ item: Instrument; cashQuote: Quote; futureQuote: Quote; signal: Candle; sma20: number; volume: number }>

    // Daily High > 50 is checked from the current session high in the cash quote.
    const highCandidates = volumeCandidates.filter(row => {
      const pass = Number(row.cashQuote.ohlc?.high ?? 0) > 50
      if (pass) diagnostics.dailyHighPass++
      return pass
    })

    // Only volume-qualified candidates reach the cash/history stage. This keeps the scanner
    // within Upstox's normal 50 req/sec / 500 req/min limits while preserving the 3 filters.
    const rows = await parallel(highCandidates, async ({ item, cashQuote, futureQuote, signal, sma20, volume }) => {
      try {
        const [cashBarsRaw, previousDay] = await Promise.all([getIntraday5m(item.underlying_key!, token), getPreviousDaily(item.underlying_key!, token)])
        const cashBars = cashBarsRaw.filter(c => dayOf(c) === today).sort((a, b) => timeOf(a) - timeOf(b))
        diagnostics.cashBars += cashBars.length
        if (!previousDay || cashBars.length < 2) return null
        const cashSignal = cashBars[cashBars.length - 2]
        const pdh = Number(previousDay[2]) || 0, pdl = Number(previousDay[3]) || 0
        const breaksHigh = Number(cashSignal[2]) > pdh, breaksLow = Number(cashSignal[3]) < pdl
        if (!breaksHigh && !breaksLow) return null
        diagnostics.cashBreakoutPass++; diagnostics.finalPass++
        return {
          rank: 0,
          symbol: item.underlying_symbol!.toUpperCase(),
          name: item.name || item.trading_symbol || item.underlying_symbol!,
          bias: breaksHigh ? 'LONG' : 'SHORT',
          change: Number(cashQuote.net_change ?? 0),
          lastPrice: Number(cashQuote.last_price),
          futurePrice: Number(futureQuote.last_price),
          rvol: Number((sma20 ? volume / sma20 : 0).toFixed(2)),
          volume,
          avgVolume20: Math.round(sma20),
          breakout: breaksHigh ? 'PDH BREAK' : 'PDL BREAK',
          signalTime: cashSignal[0],
          score: 100,
          setup: `[-1] 5M FUTURES VOLUME > [-1] 5M SMA(VOLUME,20) × 2 + [-1] 5M ${breaksHigh ? 'HIGH > 1 DAY AGO HIGH' : 'LOW < 1 DAY AGO LOW'} + DAILY HIGH > 50`,
          dailyHigh: Number((cashQuote.ohlc?.high ?? 0).toFixed(2)),
          prevDayHigh: pdh,
          prevDayLow: pdl,
          conditions: { futuresVolume: true, cashBreakout: true, dailyHighAbove50: true },
        }
      } catch { diagnostics.errors++; return null }
    })

    const candidates = rows.filter(Boolean).sort((a: any, b: any) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime()).slice(0, TOP).map((row: any, index) => ({ ...row, rank: index + 1 }))
    const indexKeys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank', 'NSE_INDEX|Nifty Midcap 100', 'NSE_INDEX|India VIX']
    const indexQuotes = await getQuotes(indexKeys, token)
    const labels = ['NIFTY 50', 'BANK NIFTY', 'NIFTY MIDCAP', 'INDIA VIX']
    const indexes = indexKeys.map((key, index) => {
      const quote = indexQuotes.byKey.get(norm(key)) ?? indexQuotes.bySymbol.get(labels[index])
      const change = quote?.last_price && quote.net_change != null ? quote.net_change / (quote.last_price - quote.net_change) * 100 : null
      return { title: labels[index], value: quote?.last_price ?? null, change }
    })

    return NextResponse.json({ ok: true, source: 'UPSTOX • EXACT 3-FILTER SCANNER', timestamp: new Date().toISOString(), universeCount: universe.length, scanned: matched.length, candidates, expiry: nearestExpiry, indexes, diagnostics, filter: {
      all: true, filters: 3, volumeMultiplier: 2,
      volume: '[-1] 5 MINUTE Volume > [-1] 5 MINUTE SMA(Volume,20) × 2',
      cash: '[-1] 5 MINUTE High > 1 DAY AGO High OR [-1] 5 MINUTE Low < 1 DAY AGO Low',
      dailyHigh: 'Daily High > 50',
    } })
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Market scan failed' }, { status: 500 })
  }
}
