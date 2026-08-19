import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2 = 'https://api.upstox.com/v2'
const V3 = 'https://api.upstox.com/v3'
const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY = 8
const TOP = 100
const VOLUME_MULTIPLIER = 2
const CPR_WIDTH_PCT = 0.5

type I = {
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

type Q = {
  instrument_token: string
  symbol: string
  last_price: number
  volume?: number
  net_change?: number
  oi?: number
}

type C = [string, number, number, number, number, number, number]

type O = {
  prev_ohlc?: { open: number; high: number; low: number; close: number; volume: number; ts: number }
  live_ohlc?: { open: number; high: number; low: number; close: number; volume: number; ts: number }
}

function key(x?: string | null) {
  return x?.trim().replace('|', ':') ?? ''
}

function date(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const y = +p.find(x => x.type === 'year')!.value
  const m = +p.find(x => x.type === 'month')!.value
  const d = +p.find(x => x.type === 'day')!.value
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

function day(c: C[]) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(c[0]))
}

function ts(c: C[]) {
  return new Date(c[0]).getTime()
}

function avg(a: number[]) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
}

function expiry(x?: number | string) {
  if (typeof x === 'string') {
    const t = Date.parse(x)
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
  }
  if (typeof x === 'number' && Number.isFinite(x)) {
    return new Date(x < 1e12 ? x * 1000 : x).toISOString().slice(0, 10)
  }
  return ''
}

async function api(url: string, token: string, label: string) {
  let last = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store'
    })
    if (r.ok) return await r.json()
    last = r.status
    if (r.status !== 429) throw Error(`${label} failed: ${r.status}`)
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
  }
  throw Error(`${label} failed: ${last}`)
}

async function instrumentMaster() {
  const r = await fetch(MASTER, { cache: 'no-store' })
  if (!r.ok) throw Error(`Instrument master failed: ${r.status}`)
  const b = Buffer.from(await r.arrayBuffer())
  let s = ''
  try { s = gunzipSync(b).toString() } catch { s = b.toString() }
  return JSON.parse(s) as I[]
}

async function quotes(keys: string[], token: string) {
  const out: Record<string, Q> = {}
  for (let i = 0; i < keys.length; i += 400) {
    const u = new URL(`${V2}/market-quote/quotes`)
    u.searchParams.set('instrument_key', keys.slice(i, i + 400).join(','))
    const d = (await api(u.toString(), token, 'Quotes')).data ?? {}
    for (const [k, q] of Object.entries(d) as [string, Q][]) {
      out[key(k)] = q
      out[key(q.instrument_token)] = q
    }
  }
  return out
}

async function dailyOHLC(keys: string[], token: string) {
  const out: Record<string, O> = {}
  for (let i = 0; i < keys.length; i += 400) {
    const u = new URL(`${V3}/market-quote/ohlc`)
    u.searchParams.set('instrument_key', keys.slice(i, i + 400).join(','))
    u.searchParams.set('interval', '1d')
    const d = (await api(u.toString(), token, 'Daily OHLC')).data ?? {}
    for (const [k, q] of Object.entries(d) as [string, O][]) out[key(k)] = q
  }
  return out
}

async function historical(k: string, token: string, to: string, from: string) {
  const u = `${V3}/historical-candle/${encodeURIComponent(k)}/minutes/5/${to}/${from}`
  const d = await api(u, token, '5M history')
  return (d.data?.candles ?? []) as C[]
}

async function intraday(k: string, token: string) {
  const d = await api(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/5`, token, '5M intraday')
  return (d.data?.candles ?? []) as C[]
}

async function mapLimit<T, R>(a: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(a.length)
  let i = 0
  async function worker() {
    while (true) {
      const j = i++
      if (j >= a.length) return
      out[j] = await fn(a[j])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, a.length) }, worker))
  return out
}

function narrowCPR(prev?: { high: number; low: number; close: number }) {
  if (!prev || ![prev.high, prev.low, prev.close].every(Number.isFinite)) return null
  const pivot = (prev.high + prev.low + prev.close) / 3
  const bc = (prev.high + prev.low) / 2
  const tc = 2 * pivot - bc
  const width = Math.abs(tc - bc)
  const pct = pivot ? width / pivot * 100 : Infinity
  return { pivot, bc, tc, width, pct, pass: pct < CPR_WIDTH_PCT }
}

function dayBars(a: C[], d: string) {
  return a.filter(c => day(c) === d).sort((x, y) => ts(x) - ts(y))
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN
  if (!token) {
    return NextResponse.json({ ok: false, error: 'UPSTOX_ANALYTICS_TOKEN is not configured' }, { status: 500 })
  }

  try {
    const all = await instrumentMaster()
    const today = date()
    const yesterday = date(-1)

    // Build the current-month NSE equity-F&O universe.
    const futures = all.filter(x =>
      x.segment === 'NSE_FO' &&
      x.instrument_type === 'FUT' &&
      x.underlying_type === 'EQUITY' &&
      x.underlying_key &&
      x.underlying_symbol &&
      expiry(x.expiry) >= today
    )

    const near = Array.from(new Set(futures.map(x => expiry(x.expiry)).filter(Boolean))).sort()[0]
    const bySymbol = new Map<string, I>()
    for (const x of futures.filter(x => expiry(x.expiry) === near)) {
      bySymbol.set(x.underlying_symbol!.toUpperCase(), x)
    }
    const stocks = [...bySymbol.values()]
    if (!stocks.length) throw Error('NSE F&O universe is empty')

    const cashKeys = stocks.map(x => x.underlying_key!)

    const diagnostics = {
      universe: stocks.length,
      dailyQuoteMatched: 0,
      cprPass: 0,
      dailyHighPass: 0,
      cashChecked: 0,
      currentCashBreakout: 0,
      futuresChecked: 0,
      futuresBars: 0,
      volumePass: 0,
      finalPass: 0,
      errors: 0
    }

    // IMPORTANT PERFORMANCE FIX:
    // Do the cheap batch daily filters FIRST. Previously the app requested
    // 5M candles for the entire F&O universe before applying CPR/daily-high.
    // That caused slow Vercel requests and the UI stayed at "Connecting...".
    const cashOHLC = await dailyOHLC(cashKeys, token)

    const dailyCandidates = stocks.map(item => {
      const ohlc = cashOHLC[key(item.underlying_key)]
      const prevH = ohlc?.prev_ohlc?.high ?? NaN
      const prevL = ohlc?.prev_ohlc?.low ?? NaN
      const prevC = ohlc?.prev_ohlc?.close ?? NaN
      const cpr = narrowCPR({ high: prevH, low: prevL, close: prevC })
      const dailyHigh = ohlc?.live_ohlc?.high ?? 0
      return { item, cashKey: key(item.underlying_key), ohlc, cpr, dailyHigh }
    }).filter(u => {
      if (!u.ohlc?.prev_ohlc) return false
      diagnostics.dailyQuoteMatched++
      if (!u.cpr?.pass) return false
      diagnostics.cprPass++
      if (!(u.dailyHigh > 50)) return false
      diagnostics.dailyHighPass++
      return true
    })

    // Only narrow-CPR + daily-high stocks now need 5M cash candles.
    const cashRows = await mapLimit(dailyCandidates, CONCURRENCY, async u => {
      try {
        return { ...u, cashBars: dayBars(await intraday(u.cashKey, token), today) }
      } catch {
        diagnostics.errors++
        return { ...u, cashBars: [] as C[] }
      }
    })

    // Exact cash breakout: latest 5M candle itself must break PDH or PDL.
    const preCandidates = cashRows.filter(u => {
      diagnostics.cashChecked++
      if (!u.cashBars.length) return false
      const current = u.cashBars[u.cashBars.length - 1]
      const prevH = u.ohlc?.prev_ohlc?.high ?? NaN
      const prevL = u.ohlc?.prev_ohlc?.low ?? NaN
      const breakoutHigh = +current[2] > prevH
      const breakoutLow = +current[3] < prevL
      if (!breakoutHigh && !breakoutLow) return false
      diagnostics.currentCashBreakout++
      return true
    })

    // Futures volume is the final expensive filter, so only breakout stocks reach it.
    const rows = await mapLimit(preCandidates, CONCURRENCY, async ({ item, futureKey, ohlc, cashBars }) => {
      try {
        diagnostics.futuresChecked++
        const fBars = dayBars(await intraday(futureKey, token), today)
        if (!fBars.length) return null
        diagnostics.futuresBars++

        const currentF = fBars[fBars.length - 1]
        const currentTs = ts(currentF)
        const previousToday = fBars.filter(c => ts(c) < currentTs)
        let history = [...previousToday]

        if (history.length < 19) {
          const hist = await historical(futureKey, token, yesterday, date(-30))
          history = [...hist.filter(c => day(c) < today), ...history].sort((a, b) => ts(a) - ts(b))
        }

        const prior19 = history.slice(-19).map(c => +c[5] || 0)
        if (prior19.length < 19) return null

        const fv = +currentF[5] || 0
        const sma20 = avg([...prior19, fv])
        const volumePass = sma20 > 0 && fv > sma20 * VOLUME_MULTIPLIER
        if (!volumePass) return null
        diagnostics.volumePass++

        const currentCash = cashBars[cashBars.length - 1]
        const prevH = ohlc?.prev_ohlc?.high ?? NaN
        const prevL = ohlc?.prev_ohlc?.low ?? NaN
        const breakoutHigh = +currentCash[2] > prevH
        const breakoutLow = +currentCash[3] < prevL
        if (!breakoutHigh && !breakoutLow) return null

        const cpr = narrowCPR({
          high: prevH,
          low: prevL,
          close: ohlc?.prev_ohlc?.close ?? NaN
        })!
        const dailyHigh = ohlc?.live_ohlc?.high ?? Math.max(...cashBars.map(c => +c[2]))
        diagnostics.finalPass++

        return {
          rank: 0,
          symbol: item.underlying_symbol!.toUpperCase(),
          name: item.name || item.trading_symbol || item.underlying_symbol!,
          bias: breakoutHigh ? 'LONG' : 'SHORT',
          lastPrice: 0,
          futurePrice: 0,
          change: 0,
          rvol: +(fv / sma20).toFixed(2),
          volume: fv,
          avgVolume20: +sma20.toFixed(0),
          breakout: breakoutHigh ? 'PDH BREAK' : 'PDL BREAK',
          signalTime: currentF[0],
          score: 100,
          setup: `5M FUT VOL > 2× SMA20 + ${breakoutHigh ? 'PDH' : 'PDL'} BREAK + NARROW CPR`,
          cpr,
          cprWidth: +cpr.pct.toFixed(3),
          dailyHigh: +dailyHigh.toFixed(2),
          prevDayHigh: prevH,
          prevDayLow: prevL,
          conditions: {
            futuresVolume: true,
            cashBreakout: true,
            dailyHighAbove50: true,
            narrowCPR: true
          }
        }
      } catch {
        diagnostics.errors++
        return null
      }
    })

    const candidates = rows.filter(Boolean).sort((a: any, b: any) =>
      new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime()
    ).slice(0, TOP).map((x: any, i) => ({ ...x, rank: i + 1 }))

    // Batch quote only the final candidates for display values.
    const finalCashKeys = candidates.map((x: any) => {
      const s = stocks.find(i => i.underlying_symbol?.toUpperCase() === x.symbol)
      return s?.underlying_key
    }).filter(Boolean) as string[]
    const finalFutureKeys = candidates.map((x: any) => {
      const s = stocks.find(i => i.underlying_symbol?.toUpperCase() === x.symbol)
      return s?.instrument_key
    }).filter(Boolean) as string[]

    const [cashQuotes, futureQuotes] = await Promise.all([
      quotes(finalCashKeys, token),
      quotes(finalFutureKeys, token)
    ])

    for (const c of candidates as any[]) {
      const s = stocks.find(i => i.underlying_symbol?.toUpperCase() === c.symbol)
      if (s) {
        const cq = cashQuotes[key(s.underlying_key)]
        const fq = futureQuotes[key(s.instrument_key)]
        c.lastPrice = cq?.last_price ?? 0
        c.change = Number(cq?.net_change ?? 0)
        c.futurePrice = fq?.last_price ?? 0
      }
    }

    return NextResponse.json({
      ok: true,
      source: 'UPSTOX • EXACT FILTER SCANNER',
      timestamp: new Date().toISOString(),
      universeCount: stocks.length,
      scanned: stocks.length,
      candidates,
      expiry: near,
      diagnostics,
      filter: {
        all: true,
        volumeMultiplier: VOLUME_MULTIPLIER,
        cprWidthPct: CPR_WIDTH_PCT,
        volume: 'CURRENT 5M FUTURES Volume > 2 × CURRENT 5M SMA(Volume,20)',
        cash: 'CURRENT 5M CASH High > previous day High OR CURRENT 5M CASH Low < previous day Low',
        dailyHigh: 'Current Daily High > 50',
        cpr: 'Previous-day CPR width / Pivot < 0.5%'
      }
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Market scan failed' }, { status: 500 })
  }
}
