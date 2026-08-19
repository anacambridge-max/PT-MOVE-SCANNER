import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration = 60

const V2 = 'https://api.upstox.com/v2'
const V3 = 'https://api.upstox.com/v3'
const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY = 20
const TOP = 100
const VOLUME_MULTIPLIER = 2
const SESSION_START = '09:15'

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
  instrument_token?: string
  symbol?: string
  last_price: number
  volume?: number
  net_change?: number
}

type Candle = [string, number, number, number, number, number, number]
type PreviousDay = { high: number; low: number; open: number; close: number; date: string }

const average = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
const candleTime = (c: Candle) => new Date(c[0]).getTime()

function istDate(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const y = Number(p.find(x => x.type === 'year')!.value)
  const m = Number(p.find(x => x.type === 'month')!.value)
  const d = Number(p.find(x => x.type === 'day')!.value)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

function candleDay(c: Candle) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(c[0]))
}

function hhmm(c: Candle) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(c[0]))
}

function expiryDate(value?: number | string) {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10)
  return ''
}

async function upstox(url: string, token: string, label: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (response.ok) return response.json()
    if (response.status !== 429) throw new Error(`${label} failed: ${response.status}`)
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
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

// Upstox Full Market Quotes returns keys such as NSE_EQ:NHPC even when the
// request used the canonical instrument key NSE_EQ|INE.... Index by both the
// response key and its symbol so cash/futures matching is reliable.
async function getQuotes(keys: string[], token: string) {
  const output: Record<string, Quote> = {}
  for (let i = 0; i < keys.length; i += 500) {
    const requested = keys.slice(i, i + 500)
    const url = new URL(`${V2}/market-quote/quotes`)
    url.searchParams.set('instrument_key', requested.join(','))
    const data = (await upstox(url.toString(), token, 'Market quotes')).data ?? {}
    for (const [responseKey, quote] of Object.entries(data) as [string, Quote][]) {
      const q = quote as Quote
      output[responseKey.toUpperCase()] = q
      const parts = responseKey.split(':')
      if (parts[1]) output[parts.slice(1).join(':').toUpperCase()] = q
      if (q.symbol) output[q.symbol.toUpperCase()] = q
      if (q.instrument_token) output[q.instrument_token.toUpperCase()] = q
    }
  }
  return output
}

async function getIntraday5m(key: string, token: string) {
  const data = await upstox(`${V3}/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`, token, '5M intraday')
  return (data.data?.candles ?? []) as Candle[]
}

async function getHistorical5m(key: string, toDate: string, fromDate: string, token: string) {
  const data = await upstox(`${V3}/historical-candle/${encodeURIComponent(key)}/minutes/5/${toDate}/${fromDate}`, token, '5M history')
  return (data.data?.candles ?? []) as Candle[]
}

async function getPreviousDay(key: string, token: string): Promise<PreviousDay | null> {
  const today = istDate()
  const data = await upstox(`${V3}/historical-candle/${encodeURIComponent(key)}/days/1/${today}/${istDate(-10)}`, token, 'Daily history')
  const candles = (data.data?.candles ?? []) as Candle[]
  const completed = candles.filter(c => candleDay(c) < today).sort((a, b) => candleTime(b) - candleTime(a))
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
  if (!token) return NextResponse.json({ ok: false, error: 'Upstox token is not configured.' }, { status: 500 })

  try {
    const today = istDate()
    const fromDate = istDate(-7)
    const instruments = await loadNseMaster()

    const futures = instruments.filter(item =>
      item.segment === 'NSE_FO' && item.instrument_type === 'FUT' && item.underlying_type === 'EQUITY' &&
      item.underlying_key && item.underlying_symbol && expiryDate(item.expiry) >= today,
    )

    const nearestExpiry = [...new Set(futures.map(x => expiryDate(x.expiry)).filter(Boolean))].sort()[0]
    const bySymbol = new Map<string, Instrument>()
    for (const future of futures.filter(x => expiryDate(x.expiry) === nearestExpiry)) bySymbol.set(future.underlying_symbol!.toUpperCase(), future)
    const universe = [...bySymbol.values()]
    if (!universe.length) throw new Error('NSE F&O universe is empty')

    const cashQuotes = await getQuotes(universe.map(x => x.underlying_key!), token)
    const futureQuotes = await getQuotes(universe.map(x => x.instrument_key), token)

    const matched = universe.map(item => {
      const cashQuote = cashQuotes[item.underlying_symbol!.toUpperCase()]
      const futureQuote = futureQuotes[(item.trading_symbol || '').toUpperCase()] || futureQuotes[item.instrument_key.toUpperCase()]
      return { item, cashKey: item.underlying_key!, futureKey: item.instrument_key, cashQuote, futureQuote }
    }).filter(x => x.cashQuote?.last_price > 0 && x.futureQuote?.last_price > 0)

    const diagnostics = { universe: universe.length, quoteMatched: matched.length, previousDayMatched: 0, cashBars: 0, futuresBars: 0, dailyHighPass: 0, cashBreakoutPass: 0, volumePass: 0, finalPass: 0, errors: 0 }

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

        const futureBars = futureBarsRaw.sort((a, b) => candleTime(a) - candleTime(b))
        const cashBars = cashBarsRaw.sort((a, b) => candleTime(a) - candleTime(b))
        const historyBars = historyRaw.sort((a, b) => candleTime(a) - candleTime(b))
        const todayCash = cashBars.filter(c => candleDay(c) === today && hhmm(c) >= SESSION_START)
        const todayFuture = futureBars.filter(c => candleDay(c) === today && hhmm(c) >= SESSION_START)
        diagnostics.futuresBars += todayFuture.length
        diagnostics.cashBars += todayCash.length
        if (!todayCash.length || !todayFuture.length) return null

        // Build a timestamp lookup. We deliberately evaluate EVERY completed 5M
        // candle from 09:15 onward, so a stock that passed at 10:20 remains in
        // today's results even if it no longer passes at the current candle.
        const futureByTime = new Map(todayFuture.map(c => [candleTime(c), c]))
        const allFuture = [...historyBars, ...futureBars].sort((a, b) => candleTime(a) - candleTime(b))
        const qualifying: { cash: Candle; future: Candle; rvol: number; sma20: number; dailyHigh: number; breaksHigh: boolean; breaksLow: boolean }[] = []
        let runningDailyHigh = 0

        for (const cash of todayCash) {
          const future = futureByTime.get(candleTime(cash))
          if (!future) continue
          runningDailyHigh = Math.max(runningDailyHigh, Number(cash[2]) || 0)
          // Daily High > 50 is a running intraday condition.
          if (!(runningDailyHigh > 50)) continue
          diagnostics.dailyHighPass++

          const pdh = previousDay.high
          const pdl = previousDay.low
          const breaksHigh = Number(cash[2]) > pdh
          const breaksLow = Number(cash[3]) < pdl
          if (!breaksHigh && !breaksLow) continue
          diagnostics.cashBreakoutPass++

          const idx = allFuture.findIndex(c => candleTime(c) === candleTime(future))
          if (idx < 19) continue
          const window = allFuture.slice(idx - 19, idx + 1).map(c => Number(c[5]) || 0)
          const sma20 = average(window)
          const currentVolume = Number(future[5]) || 0
          const rvol = sma20 ? currentVolume / sma20 : 0
          if (!(sma20 > 0 && currentVolume > sma20 * VOLUME_MULTIPLIER)) continue
          diagnostics.volumePass++
          diagnostics.finalPass++
          qualifying.push({ cash, future, rvol, sma20, dailyHigh: runningDailyHigh, breaksHigh, breaksLow })
        }

        const hit = qualifying[qualifying.length - 1]
        if (!hit) return null
        return {
          rank: 0,
          symbol: item.underlying_symbol!.toUpperCase(),
          name: item.name || item.trading_symbol || item.underlying_symbol!,
          bias: hit.breaksHigh ? 'LONG' : 'SHORT',
          change: Number(cashQuote.net_change ?? 0),
          lastPrice: Number(cashQuote.last_price),
          futurePrice: Number(futureQuote.last_price),
          rvol: Number(hit.rvol.toFixed(2)),
          volume: Number(hit.future[5]) || 0,
          avgVolume20: Math.round(hit.sma20),
          breakout: hit.breaksHigh ? 'PDH BREAK' : 'PDL BREAK',
          signalTime: hit.cash[0],
          score: 100,
          setup: `TODAY ${SESSION_START}+ • 5M FUTURES VOLUME > 2× SMA(20) + ${hit.breaksHigh ? '5M HIGH > 1 DAY AGO HIGH' : '5M LOW < 1 DAY AGO LOW'} + DAILY HIGH > 50`,
          dailyHigh: Number(hit.dailyHigh.toFixed(2)),
          prevDayHigh: previousDay.high,
          prevDayLow: previousDay.low,
          conditions: { futuresVolume: true, cashBreakout: true, dailyHighAbove50: true },
        }
      } catch {
        diagnostics.errors++
        return null
      }
    })

    const candidates = rows.filter(Boolean).sort((a: any, b: any) => candleTime([b.signalTime, 0, 0, 0, 0, 0, 0]) - candleTime([a.signalTime, 0, 0, 0, 0, 0, 0])).slice(0, TOP).map((row: any, index) => ({ ...row, rank: index + 1 }))

    const indexKeys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank', 'NSE_INDEX|Nifty Midcap 100', 'NSE_INDEX|India VIX']
    const indexQuotes = await getQuotes(indexKeys, token)
    const labels = ['NIFTY 50', 'BANK NIFTY', 'NIFTY MIDCAP', 'INDIA VIX']
    const indexes = indexKeys.map((key, index) => {
      const q = indexQuotes[key.toUpperCase()] || indexQuotes[labels[index].toUpperCase()]
      const change = q?.last_price && q.net_change != null ? q.net_change / (q.last_price - q.net_change) * 100 : null
      return { title: labels[index], value: q?.last_price ?? null, change }
    })

    return NextResponse.json({
      ok: true,
      source: 'UPSTOX • TODAY 09:15+ LIVE SIGNAL HISTORY',
      timestamp: new Date().toISOString(),
      sessionStart: SESSION_START,
      universeCount: universe.length,
      scanned: matched.length,
      candidates,
      expiry: nearestExpiry,
      indexes,
      diagnostics,
      filter: { all: true, filters: 3, volumeMultiplier: 2, volume: '[-1] 5 MINUTE Volume > [-1] 5 MINUTE SMA(Volume,20) × 2', cash: '[-1] 5 MINUTE High > 1 DAY AGO High OR [-1] 5 MINUTE Low < 1 DAY AGO Low', dailyHigh: 'Daily High > 50', history: 'ALL qualifying signals from today 09:15 onward are retained; latest signal shown per stock' },
    })
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Market scan failed' }, { status: 500 })
  }
}
