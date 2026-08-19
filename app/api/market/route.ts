import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration = 60

const V2 = 'https://api.upstox.com/v2'
const V3 = 'https://api.upstox.com/v3'
const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY = 8
const HIST_CONCURRENCY = 5
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

type Quote = { instrument_token?: string; symbol?: string; last_price: number; volume?: number; net_change?: number }
type Candle = [string, number, number, number, number, number, number]
type Prev = { high: number; low: number; open: number; close: number; ts?: number }

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
  let lastStatus = 0
  let lastBody = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (response.ok) return response.json()
    lastStatus = response.status
    lastBody = await response.text().catch(() => '')
    if (response.status !== 429) throw new Error(`${label} failed: ${response.status}${lastBody ? ` ${lastBody.slice(0, 180)}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)))
  }
  throw new Error(`${label} failed: ${lastStatus || 'rate limited'}${lastBody ? ` ${lastBody.slice(0, 180)}` : ''}`)
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
  for (let i = 0; i < keys.length; i += 500) {
    const url = new URL(`${V2}/market-quote/quotes`)
    url.searchParams.set('instrument_key', keys.slice(i, i + 500).join(','))
    const data = (await upstox(url.toString(), token, 'Market quotes')).data ?? {}
    for (const [responseKey, quote] of Object.entries(data) as [string, Quote][]) {
      output[responseKey.toUpperCase()] = quote
      const parts = responseKey.split(':')
      if (parts[1]) output[parts.slice(1).join(':').toUpperCase()] = quote
      if (quote.symbol) output[quote.symbol.toUpperCase()] = quote
      if (quote.instrument_token) output[quote.instrument_token.toUpperCase()] = quote
    }
  }
  return output
}

async function getDailyPrev(keys: string[], token: string) {
  const output: Record<string, Prev> = {}
  for (let i = 0; i < keys.length; i += 500) {
    const url = new URL(`${V3}/market-quote/ohlc`)
    url.searchParams.set('instrument_key', keys.slice(i, i + 500).join(','))
    url.searchParams.set('interval', '1d')
    const data = (await upstox(url.toString(), token, 'Daily OHLC')).data ?? {}
    for (const [responseKey, value] of Object.entries(data) as [string, any][]) {
      const prev = value?.prev_ohlc
      if (!prev) continue
      const normalized: Prev = { open: Number(prev.open), high: Number(prev.high), low: Number(prev.low), close: Number(prev.close), ts: Number(prev.ts) }
      output[responseKey.toUpperCase()] = normalized
      const parts = responseKey.split(':')
      if (parts[1]) output[parts.slice(1).join(':').toUpperCase()] = normalized
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

    // Current nearest non-expired NSE stock futures, one contract per underlying.
    const futures = instruments.filter(item =>
      item.segment === 'NSE_FO' && item.instrument_type === 'FUT' && item.underlying_type === 'EQUITY' &&
      item.underlying_key && item.underlying_symbol && expiryDate(item.expiry) >= today,
    )
    const nearestExpiry = [...new Set(futures.map(x => expiryDate(x.expiry)).filter(Boolean))].sort()[0]
    const bySymbol = new Map<string, Instrument>()
    for (const future of futures.filter(x => expiryDate(x.expiry) === nearestExpiry)) bySymbol.set(future.underlying_symbol!.toUpperCase(), future)
    const universe = [...bySymbol.values()]
    if (!universe.length) throw new Error('NSE F&O universe is empty')

    // Batch quotes and previous-session OHLC. V3 OHLC prev_ohlc is explicitly
    // the previous trading session, so there is no need for 208 daily-history calls.
    const [cashQuotes, futureQuotes, prevDaily] = await Promise.all([
      getQuotes(universe.map(x => x.underlying_key!), token),
      getQuotes(universe.map(x => x.instrument_key), token),
      getDailyPrev(universe.map(x => x.underlying_key!), token),
    ])

    const matched = universe.map(item => {
      const symbol = item.underlying_symbol!.toUpperCase()
      const cashQuote = cashQuotes[symbol]
      const futureQuote = futureQuotes[(item.trading_symbol || '').toUpperCase()] || futureQuotes[item.instrument_key.toUpperCase()]
      const prev = prevDaily[symbol] || prevDaily[item.underlying_key!.toUpperCase()]
      return { item, cashKey: item.underlying_key!, futureKey: item.instrument_key, cashQuote, futureQuote, prev }
    }).filter(x => x.cashQuote?.last_price > 0 && x.futureQuote?.last_price > 0 && x.prev)

    const diagnostics: any = {
      universe: universe.length,
      quoteMatched: matched.length,
      previousDayMatched: matched.length,
      todayCashCandidates: 0,
      cashBars: 0,
      futuresBars: 0,
      dailyHighPass: 0,
      cashBreakoutPass: 0,
      volumePass: 0,
      finalPass: 0,
      errors: 0,
      errorSample: '',
    }

    // Stage 1: only cash 5M candles. This finds today's PDH/PDL breakouts before
    // touching futures history, greatly reducing API calls and avoiding bursts.
    const cashStage = await parallel(matched, CONCURRENCY, async (m) => {
      try {
        const raw = await getIntraday5m(m.cashKey, token)
        const bars = raw.sort((a, b) => candleTime(a) - candleTime(b)).filter(c => candleDay(c) === today && hhmm(c) >= SESSION_START)
        diagnostics.cashBars += bars.length
        let dayHigh = 0
        let breakoutHits = 0
        const hits: { time: number; cash: Candle; dailyHigh: number; breaksHigh: boolean; breaksLow: boolean }[] = []
        for (const cash of bars) {
          dayHigh = Math.max(dayHigh, Number(cash[2]) || 0)
          if (!(dayHigh > 50)) continue
          diagnostics.dailyHighPass++
          const breaksHigh = Number(cash[2]) > m.prev!.high
          const breaksLow = Number(cash[3]) < m.prev!.low
          if (!breaksHigh && !breaksLow) continue
          breakoutHits++
          diagnostics.cashBreakoutPass++
          hits.push({ time: candleTime(cash), cash, dailyHigh: dayHigh, breaksHigh, breaksLow })
        }
        if (breakoutHits) diagnostics.todayCashCandidates++
        return hits.length ? { ...m, hits } : null
      } catch (error: any) {
        diagnostics.errors++
        if (!diagnostics.errorSample) diagnostics.errorSample = `${m.item.underlying_symbol}: ${error?.message || 'API error'}`
        return null
      }
    })

    const candidates = cashStage.filter(Boolean) as any[]

    // Stage 2: only fetch futures candles for stocks that actually broke PDH/PDL today.
    const rows = await parallel(candidates, HIST_CONCURRENCY, async (m: any) => {
      try {
        const [futureRaw, historyRaw] = await Promise.all([
          getIntraday5m(m.futureKey, token),
          getHistorical5m(m.futureKey, istDate(-1), fromDate, token),
        ])
        const todayFuture = futureRaw.sort((a: Candle, b: Candle) => candleTime(a) - candleTime(b)).filter((c: Candle) => candleDay(c) === today && hhmm(c) >= SESSION_START)
        const history = historyRaw.sort((a: Candle, b: Candle) => candleTime(a) - candleTime(b))
        diagnostics.futuresBars += todayFuture.length
        if (!todayFuture.length) return null

        const byTime = new Map(todayFuture.map((c: Candle) => [candleTime(c), c]))
        const allFuture = [...history, ...todayFuture].sort((a: Candle, b: Candle) => candleTime(a) - candleTime(b))
        const qualifying: any[] = []

        for (const hit of m.hits) {
          const future = byTime.get(hit.time)
          if (!future) continue
          const idx = allFuture.findIndex(c => candleTime(c) === hit.time)
          if (idx < 19) continue
          const window = allFuture.slice(idx - 19, idx + 1).map(c => Number(c[5]) || 0)
          const sma20 = average(window)
          const currentVolume = Number(future[5]) || 0
          const rvol = sma20 ? currentVolume / sma20 : 0
          if (!(sma20 > 0 && currentVolume > sma20 * VOLUME_MULTIPLIER)) continue
          diagnostics.volumePass++
          diagnostics.finalPass++
          qualifying.push({ ...hit, future, rvol, sma20 })
        }

        const hit = qualifying[qualifying.length - 1]
        if (!hit) return null
        return {
          rank: 0,
          symbol: m.item.underlying_symbol!.toUpperCase(),
          name: m.item.name || m.item.trading_symbol || m.item.underlying_symbol!,
          bias: hit.breaksHigh ? 'LONG' : 'SHORT',
          change: Number(m.cashQuote.net_change ?? 0),
          lastPrice: Number(m.cashQuote.last_price),
          futurePrice: Number(m.futureQuote.last_price),
          rvol: Number(hit.rvol.toFixed(2)),
          volume: Number(hit.future[5]) || 0,
          avgVolume20: Math.round(hit.sma20),
          breakout: hit.breaksHigh ? 'PDH BREAK' : 'PDL BREAK',
          signalTime: hit.cash[0],
          score: 100,
          setup: `TODAY ${SESSION_START}+ • 5M FUTURES VOLUME > 2× SMA(20) + ${hit.breaksHigh ? '5M HIGH > 1 DAY AGO HIGH' : '5M LOW < 1 DAY AGO LOW'} + DAILY HIGH > 50`,
          dailyHigh: Number(hit.dailyHigh.toFixed(2)),
          prevDayHigh: m.prev.high,
          prevDayLow: m.prev.low,
          conditions: { futuresVolume: true, cashBreakout: true, dailyHighAbove50: true },
        }
      } catch (error: any) {
        diagnostics.errors++
        if (!diagnostics.errorSample) diagnostics.errorSample = `${m.item.underlying_symbol}: ${error?.message || 'API error'}`
        return null
      }
    })

    const finalRows = rows.filter(Boolean).sort((a: any, b: any) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime()).slice(0, TOP).map((row: any, index) => ({ ...row, rank: index + 1 }))

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
      candidates: finalRows,
      expiry: nearestExpiry,
      indexes,
      diagnostics,
      filter: {
        all: true,
        filters: 3,
        volumeMultiplier: 2,
        volume: '[-1] 5 MINUTE Volume > [-1] 5 MINUTE SMA(Volume,20) × 2',
        cash: '[-1] 5 MINUTE High > 1 DAY AGO High OR [-1] 5 MINUTE Low < 1 DAY AGO Low',
        dailyHigh: 'Daily High > 50',
        history: 'ALL qualifying signals from today 09:15 onward are retained; latest signal shown per stock',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Market scan failed' }, { status: 500 })
  }
}
