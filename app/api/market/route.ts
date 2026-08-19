import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration = 60

const V2 = 'https://api.upstox.com/v2'
const V3 = 'https://api.upstox.com/v3'
const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY = 12
const TOP = 100
const VOLUME_MULTIPLIER = 2

type Instrument = {
  instrument_key: string
  trading_symbol?: string
  name?: string
  segment?: string
  instrument_type?: string
  underlying_symbol?: string
  underlying_key?: string
  underlying_type?: string
  expiry?: number | string
}

type Quote = {
  instrument_token: string
  symbol: string
  last_price: number
  volume?: number
  net_change?: number
}

type Candle = [string, number, number, number, number, number, number]
type PreviousDay = { high: number; low: number; open: number; close: number; date: string }

const clean = (x?: string | null) => x?.trim().replace('|', ':') ?? ''

function istDate(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const y = Number(p.find(x => x.type === 'year')!.value)
  const m = Number(p.find(x => x.type === 'month')!.value)
  const d = Number(p.find(x => x.type === 'day')!.value)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

const candleDay = (c: Candle) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(c[0]))

const candleTime = (c: Candle) => new Date(c[0]).getTime()
const average = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0

function expiryDate(value?: number | string) {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10)
  }
  return ''
}

async function upstox(url: string, token: string, label: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (response.ok) return response.json()
    if (response.status !== 429) throw new Error(`${label} failed: ${response.status}`)
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
  }
  throw new Error(`${label} failed: rate limited`)
}

async function loadNseMaster() {
  const response = await fetch(MASTER, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Upstox instrument master failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  let json = ''
  try { json = gunzipSync(bytes).toString('utf8') } catch { json = bytes.toString('utf8') }
  return JSON.parse(json) as Instrument[]
}

async function getQuotes(keys: string[], token: string) {
  const output: Record<string, Quote> = {}
  for (let i = 0; i < keys.length; i += 400) {
    const url = new URL(`${V2}/market-quote/quotes`)
    url.searchParams.set('instrument_key', keys.slice(i, i + 400).join(','))
    const data = (await upstox(url.toString(), token, 'Market quotes')).data ?? {}
    for (const [key, quote] of Object.entries(data) as [string, Quote][]) {
      output[clean(key)] = quote
      if (quote?.instrument_token) output[clean(quote.instrument_token)] = quote
    }
  }
  return output
}

async function getIntraday5m(key: string, token: string) {
  const data = await upstox(`${V3}/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`, token, '5M intraday')
  return (data.data?.candles ?? []) as Candle[]
}

async function getHistorical5m(key: string, toDate: string, fromDate: string, token: string) {
  const data = await upstox(
    `${V3}/historical-candle/${encodeURIComponent(key)}/minutes/5/${toDate}/${fromDate}`,
    token,
    '5M history',
  )
  return (data.data?.candles ?? []) as Candle[]
}

// IMPORTANT: V3 /market-quote/ohlc with interval=1d returns the live daily OHLC,
// not the previous day's high/low. Chartink's "1 day ago High/Low" requires the
// previous completed daily candle, so fetch historical daily candles instead.
async function getPreviousDay(key: string, token: string): Promise<PreviousDay | null> {
  const today = istDate()
  const data = await upstox(
    `${V3}/historical-candle/${encodeURIComponent(key)}/days/1/${today}/${istDate(-10)}`,
    token,
    'Daily history',
  )
  const candles = (data.data?.candles ?? []) as Candle[]
  const completed = candles
    .filter(c => candleDay(c) < today)
    .sort((a, b) => candleTime(b) - candleTime(a))
  const c = completed[0]
  if (!c) return null
  return { date: candleDay(c), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }
}

async function parallel<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const result: R[] = new Array(items.length)
  let cursor = 0
  async function runWorker() {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      result[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker))
  return result
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: 'Upstox token is not configured. Add UPSTOX_ANALYTICS_TOKEN in Vercel Environment Variables.',
    }, { status: 500 })
  }

  try {
    const today = istDate()
    const fromDate = istDate(-7)
    const instruments = await loadNseMaster()

    // Universe = NSE stock futures, nearest non-expired contract, equity underlyings only.
    const futures = instruments.filter(item =>
      item.segment === 'NSE_FO' &&
      item.instrument_type === 'FUT' &&
      item.underlying_type === 'EQUITY' &&
      item.underlying_key &&
      item.underlying_symbol &&
      expiryDate(item.expiry) >= today,
    )

    const nearestExpiry = [...new Set(futures.map(x => expiryDate(x.expiry)).filter(Boolean))].sort()[0]
    const bySymbol = new Map<string, Instrument>()
    for (const future of futures.filter(x => expiryDate(x.expiry) === nearestExpiry)) {
      bySymbol.set(future.underlying_symbol!.toUpperCase(), future)
    }
    const universe = [...bySymbol.values()]
    if (!universe.length) throw new Error('NSE F&O universe is empty')

    const cashKeys = universe.map(x => x.underlying_key!)
    const futureKeys = universe.map(x => x.instrument_key)
    const [cashQuotes, futureQuotes] = await Promise.all([
      getQuotes(cashKeys, token),
      getQuotes(futureKeys, token),
    ])

    const matched = universe.map(item => ({
      item,
      cashKey: clean(item.underlying_key),
      futureKey: clean(item.instrument_key),
      cashQuote: cashQuotes[clean(item.underlying_key)],
      futureQuote: futureQuotes[clean(item.instrument_key)],
    })).filter(x => x.cashQuote?.last_price > 0 && x.futureQuote?.last_price > 0)

    const diagnostics = {
      universe: universe.length,
      quoteMatched: matched.length,
      previousDayMatched: 0,
      cashBars: 0,
      futuresBars: 0,
      dailyHighPass: 0,
      cashBreakoutPass: 0,
      volumePass: 0,
      finalPass: 0,
      errors: 0,
    }

    const rows = await parallel(matched, CONCURRENCY, async ({ item, cashKey, futureKey, cashQuote, futureQuote }) => {
      try {
        const [futureBarsRaw, cashBarsRaw, historyRaw, previousDay] = await Promise.all([
          getIntraday5m(futureKey, token),
          getIntraday5m(cashKey, token),
          getHistorical5m(futureKey, istDate(-1), fromDate, token),
          getPreviousDay(cashKey, token),
        ])

        if (!previousDay) return null
        diagnostics.previousDayMatched++

        const futureBars = futureBarsRaw.filter(x => candleDay(x) === today).sort((a, b) => candleTime(a) - candleTime(b))
        const cashBars = cashBarsRaw.filter(x => candleDay(x) === today).sort((a, b) => candleTime(a) - candleTime(b))
        const historyBars = historyRaw.filter(x => candleDay(x) !== today).sort((a, b) => candleTime(a) - candleTime(b))
        diagnostics.futuresBars += futureBars.length
        diagnostics.cashBars += cashBars.length
        if (!futureBars.length || !cashBars.length) return null

        // FILTER 03 — Daily High > 50.
        const dailyHigh = Math.max(...cashBars.map(x => Number(x[2]) || 0), Number(cashQuote.last_price) || 0)
        if (!(dailyHigh > 50)) return null
        diagnostics.dailyHighPass++

        const currentFuture = futureBars[futureBars.length - 1]
        const currentCash = cashBars[cashBars.length - 1]
        if (Math.abs(candleTime(currentFuture) - candleTime(currentCash)) > 5 * 60 * 1000) return null

        // FILTER 02 — Cash segment: ANY ONE of PDH/PDL breakout conditions.
        // These are the previous completed daily candle's High/Low, matching
        // Chartink's "1 day ago High/Low" semantics.
        const pdh = previousDay.high
        const pdl = previousDay.low
        const breaksHigh = Number(currentCash[2]) > pdh
        const breaksLow = Number(currentCash[3]) < pdl
        if (!breaksHigh && !breaksLow) return null
        diagnostics.cashBreakoutPass++

        // FILTER 01 — Futures 5M Volume > 2 × SMA(Volume,20).
        // Current candle is included in the 20-bar SMA, matching the scanner expression.
        const allFutureBars = [...historyBars, ...futureBars].sort((a, b) => candleTime(a) - candleTime(b))
        const currentIndex = allFutureBars.findIndex(x => candleTime(x) === candleTime(currentFuture))
        if (currentIndex < 19) return null
        const window = allFutureBars.slice(currentIndex - 19, currentIndex + 1).map(x => Number(x[5]) || 0)
        const sma20 = average(window)
        const currentVolume = Number(currentFuture[5]) || 0
        const rvol = sma20 ? currentVolume / sma20 : 0
        if (!(sma20 > 0 && currentVolume > sma20 * VOLUME_MULTIPLIER)) return null
        diagnostics.volumePass++
        diagnostics.finalPass++

        return {
          rank: 0,
          symbol: item.underlying_symbol!.toUpperCase(),
          name: item.name || item.trading_symbol || item.underlying_symbol!,
          bias: breaksHigh ? 'LONG' : 'SHORT',
          change: Number(cashQuote.net_change ?? 0),
          lastPrice: Number(cashQuote.last_price),
          futurePrice: Number(futureQuote.last_price),
          rvol: Number(rvol.toFixed(2)),
          volume: currentVolume,
          avgVolume20: Math.round(sma20),
          breakout: breaksHigh ? 'PDH BREAK' : 'PDL BREAK',
          signalTime: currentCash[0],
          score: 100,
          setup: `5M FUTURES VOLUME > 2× SMA(VOLUME,20) + ${breaksHigh ? '5M HIGH > 1 DAY AGO HIGH' : '5M LOW < 1 DAY AGO LOW'} + DAILY HIGH > 50`,
          dailyHigh: Number(dailyHigh.toFixed(2)),
          prevDayHigh: pdh,
          prevDayLow: pdl,
          conditions: { futuresVolume: true, cashBreakout: true, dailyHighAbove50: true },
        }
      } catch {
        diagnostics.errors++
        return null
      }
    })

    const candidates = rows
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime())
      .slice(0, TOP)
      .map((row: any, index) => ({ ...row, rank: index + 1 }))

    const indexKeys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank', 'NSE_INDEX|Nifty Midcap 100', 'NSE_INDEX|India VIX']
    const indexQuotes = await getQuotes(indexKeys, token)
    const labels = ['NIFTY 50', 'BANK NIFTY', 'NIFTY MIDCAP', 'INDIA VIX']
    const indexes = indexKeys.map((key, index) => {
      const quote = indexQuotes[clean(key)]
      const change = quote?.last_price && quote.net_change != null
        ? quote.net_change / (quote.last_price - quote.net_change) * 100
        : null
      return { title: labels[index], value: quote?.last_price ?? null, change }
    })

    return NextResponse.json({
      ok: true,
      source: 'UPSTOX • EXACT 3-FILTER SCANNER',
      timestamp: new Date().toISOString(),
      universeCount: universe.length,
      scanned: matched.length,
      candidates,
      expiry: nearestExpiry,
      indexes,
      diagnostics,
      filter: {
        all: true,
        filters: 3,
        volumeMultiplier: 2,
        volume: '5 MINUTE Volume > 5 MINUTE SMA(Volume,20) × 2',
        cash: '5 MINUTE High > 1 DAY AGO High OR 5 MINUTE Low < 1 DAY AGO Low',
        dailyHigh: 'Daily High > 50',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Market scan failed' }, { status: 500 })
  }
}
