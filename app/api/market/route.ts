import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const API_V2 = 'https://api.upstox.com/v2'
const API_V3 = 'https://api.upstox.com/v3'
const UPSTOX_NSE_INSTRUMENTS = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const MAX_TECHNICAL_SCAN = 60
const TECHNICAL_CONCURRENCY = 6
const TOP_RESULTS = 25

const indexQueries = [
  ['NIFTY 50', 'NIFTY 50'],
  ['BANKNIFTY', 'BANK NIFTY'],
  ['NIFTY MIDCAP 100', 'NIFTY MIDCAP'],
  ['INDIA VIX', 'INDIA VIX'],
] as const

type Instrument = { instrument_key: string; trading_symbol?: string; name?: string; segment?: string; instrument_type?: string; underlying_symbol?: string; underlying_key?: string; underlying_type?: string; expiry?: number | string }
type Quote = { instrument_token: string; symbol: string; last_price: number; volume?: number; net_change?: number; average_price?: number; oi?: number; oi_day_high?: number; oi_day_low?: number }
type Candle = [string, number, number, number, number, number, number]

function normalizeInstrumentKey(key?: string | null) { return key?.trim().replace('|', ':') ?? '' }
function changePercent(lastPrice: number, netChange: number) { const previousClose = lastPrice - netChange; if (!Number.isFinite(previousClose) || previousClose === 0) return 0; return (netChange / previousClose) * 100 }
function indiaDate(offsetDays = 0) {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const y = Number(parts.find(p => p.type === 'year')?.value), m = Number(parts.find(p => p.type === 'month')?.value), d = Number(parts.find(p => p.type === 'day')?.value)
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10)
}
function expiryDate(value?: number | string) {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
    const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString().slice(0, 10)
  }
  return ''
}

async function getNseFnoUniverse() {
  const response = await fetch(UPSTOX_NSE_INSTRUMENTS, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Upstox instrument master failed: ${response.status}`)
  const raw = Buffer.from(await response.arrayBuffer())
  let jsonText = ''
  try { jsonText = gunzipSync(raw).toString('utf8') } catch { jsonText = raw.toString('utf8') }
  const instruments = JSON.parse(jsonText) as Instrument[]
  const today = indiaDate(0)
  const valid = instruments.filter(item => item.segment === 'NSE_FO' && item.instrument_type === 'FUT' && item.underlying_type === 'EQUITY' && item.underlying_key && item.underlying_symbol && expiryDate(item.expiry) >= today)
  const expiries = valid.map(x => expiryDate(x.expiry)).filter(Boolean).sort()
  const nearestExpiry = expiries[0]
  if (!nearestExpiry) return { stocks: [] as Instrument[], expiry: null, universeCount: 0 }
  const currentContracts = valid.filter(x => expiryDate(x.expiry) === nearestExpiry)
  const unique = new Map<string, Instrument>()
  for (const item of currentContracts) { const symbol = item.underlying_symbol!.toUpperCase(); if (!unique.has(symbol)) unique.set(symbol, item) }
  return { stocks: Array.from(unique.values()), expiry: nearestExpiry, universeCount: unique.size }
}

async function searchInstrument(query: string, token: string) {
  const url = new URL(`${API_V2}/instruments/search`)
  url.searchParams.set('query', query); url.searchParams.set('exchanges', 'NSE'); url.searchParams.set('segments', 'INDEX'); url.searchParams.set('records', '10')
  const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!response.ok) throw new Error(`Instrument search failed: ${response.status}`)
  const body = await response.json(); const data: Instrument[] = body.data ?? []
  return data.find(item => item.trading_symbol?.toUpperCase() === query.toUpperCase() || item.name?.toUpperCase() === query.toUpperCase()) ?? data[0]
}

async function getQuotes(keys: string[], token: string) {
  if (!keys.length) return {} as Record<string, Quote>
  const chunks: string[][] = []; for (let i = 0; i < keys.length; i += 400) chunks.push(keys.slice(i, i + 400))
  const all: Record<string, Quote> = {}
  for (const chunk of chunks) {
    const url = new URL(`${API_V2}/market-quote/quotes`); url.searchParams.set('instrument_key', chunk.join(','))
    const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!response.ok) throw new Error(`Market quote failed: ${response.status}`)
    const body = await response.json(); const rawData = (body.data ?? {}) as Record<string, Quote>
    for (const [returnedKey, quote] of Object.entries(rawData)) {
      const normalized = normalizeInstrumentKey(returnedKey); if (normalized) all[normalized] = quote
      const tokenKey = normalizeInstrumentKey(quote.instrument_token); if (tokenKey) all[tokenKey] = quote
    }
  }
  return all
}

async function getDailyCandles(instrumentKey: string, token: string): Promise<Candle[]> {
  const to = indiaDate(-1), from = indiaDate(-90), encodedKey = encodeURIComponent(instrumentKey)
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` }

  // V2 daily history is the stable fallback for this scanner. V3 remains the
  // primary endpoint but a token/account may have different access behaviour.
  const v2 = await fetch(`${API_V2}/historical-candle/${encodedKey}/day/${to}/${from}`, { headers, cache: 'no-store' })
  if (v2.ok) {
    const body = await v2.json()
    const candles = (body.data?.candles ?? []) as Candle[]
    if (candles.length) return candles
  }

  const v3 = await fetch(`${API_V3}/historical-candle/${encodedKey}/days/1/${to}/${from}`, { headers, cache: 'no-store' })
  if (!v3.ok) throw new Error(`Historical candle failed: V2 ${v2.status}, V3 ${v3.status}`)
  const body = await v3.json(); return (body.data?.candles ?? []) as Candle[]
}

function avg(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 }
function ema(values: number[], period: number) { if (!values.length) return 0; const k = 2 / (period + 1); let result = values[0]; for (let i = 1; i < values.length; i++) result = values[i] * k + result * (1 - k); return result }

function analyzeT1(candlesRaw: Candle[]) {
  const candles = [...candlesRaw].sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
  if (candles.length < 22) return null
  const i = candles.length - 1, c = candles[i], prev = candles[i - 1]
  const close = Number(c[4]), open = Number(c[1]), high = Number(c[2]), low = Number(c[3]), volume = Number(c[5] ?? 0), range = Math.max(0, high - low), prevHigh = Number(prev[2]), prevLow = Number(prev[3]), prevClose = Number(prev[4])
  const priorRanges = candles.slice(Math.max(0, i - 20), i).map(x => Number(x[2]) - Number(x[3]))
  const priorVolumes = candles.slice(Math.max(0, i - 20), i).map(x => Number(x[5] ?? 0))
  const avgRange = avg(priorRanges), avgVolume = avg(priorVolumes), closes = candles.map(x => Number(x[4]))
  const ema5 = ema(closes.slice(-40), 5), ema20 = ema(closes.slice(-40), 20)
  const rangesForNr = candles.slice(Math.max(0, i - 7), i + 1).map(x => Number(x[2]) - Number(x[3]))
  const nr4 = range <= Math.min(...rangesForNr.slice(-4)), nr7 = range <= Math.min(...rangesForNr.slice(-7))
  const dayChange = prevClose ? ((close - prevClose) / prevClose) * 100 : 0, rvol = avgVolume ? volume / avgVolume : 1, rangeExpansion = avgRange ? range / avgRange : 1
  const closeLocation = range ? (close - low) / range : 0.5, bodyPct = range ? Math.abs(close - open) / range : 0
  const momentum5 = Number(candles[i - 5][4]) ? ((close / Number(candles[i - 5][4])) - 1) * 100 : 0, momentum20 = Number(candles[i - 20][4]) ? ((close / Number(candles[i - 20][4])) - 1) * 100 : 0
  const high20 = Math.max(...candles.slice(Math.max(0, i - 20), i).map(x => Number(x[2]))), low20 = Math.min(...candles.slice(Math.max(0, i - 20), i).map(x => Number(x[3])))
  const breakoutUp = close > high20, breakoutDown = close < low20
  let longScore = 0, shortScore = 0; const signals: string[] = []
  if (close > ema5 && ema5 > ema20) longScore += 18
  if (close < ema5 && ema5 < ema20) shortScore += 18
  if (momentum5 > 1) longScore += 10
  if (momentum5 < -1) shortScore += 10
  if (momentum20 > 3) longScore += 8
  if (momentum20 < -3) shortScore += 8
  if (rvol >= 1.5) { longScore += closeLocation >= 0.6 ? 14 : 0; shortScore += closeLocation <= 0.4 ? 14 : 0; signals.push(`RVOL ${rvol.toFixed(1)}x`) }
  if (rangeExpansion >= 1.4) { longScore += closeLocation >= 0.65 ? 12 : 0; shortScore += closeLocation <= 0.35 ? 12 : 0; signals.push('Range expansion') }
  if (closeLocation >= 0.75 && bodyPct >= 0.45) longScore += 10
  if (closeLocation <= 0.25 && bodyPct >= 0.45) shortScore += 10
  if (nr4) signals.push('NR4')
  if (nr7) signals.push('NR7')
  if (nr4 && closeLocation >= 0.6) longScore += 8
  if (nr4 && closeLocation <= 0.4) shortScore += 8
  if (nr7 && closeLocation >= 0.6) longScore += 7
  if (nr7 && closeLocation <= 0.4) shortScore += 7
  if (breakoutUp) { longScore += 12; signals.push('20D high breakout') }
  if (breakoutDown) { shortScore += 12; signals.push('20D low breakdown') }
  if (close > prevHigh) { longScore += 8; signals.push('PDH breakout') }
  if (close < prevLow) { shortScore += 8; signals.push('PDL breakdown') }
  const bias = longScore >= shortScore ? 'LONG' : 'SHORT', rawScore = Math.max(longScore, shortScore), score = Math.max(50, Math.min(99, rawScore + 45))
  const setup = signals.length ? signals.slice(0, 2).join(' + ') : 'Structure watch', confidence = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B+' : 'B'
  return { score, bias, change: dayChange, volume: volume ? volume.toLocaleString('en-IN') : '—', rs: bias === 'LONG' ? (momentum5 > 1 ? 'Strong' : 'Positive') : (momentum5 < -1 ? 'Weak' : 'Negative'), setup, confidence, lastPrice: close, oi: null, rvol: Number(rvol.toFixed(2)), rangePct: close ? Number(((range / close) * 100).toFixed(2)) : 0, nr4, nr7, pdBreak: breakoutUp ? 'PDH' : breakoutDown ? 'PDL' : '—', t1Date: c[0] }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length); let cursor = 0
  async function runner() { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index]) } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner())); return results
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN
  if (!token) return NextResponse.json({ ok: false, error: 'UPSTOX_ANALYTICS_TOKEN is not configured' }, { status: 500 })
  try {
    const [{ stocks: fnoStocks, expiry, universeCount }, indexes] = await Promise.all([
      getNseFnoUniverse(),
      Promise.all(indexQueries.map(async ([query, label]) => ({ query, label, instrument: await searchInstrument(query, token) }))),
    ])
    if (!fnoStocks.length) throw new Error('NSE F&O universe is empty. No current stock-futures contracts were resolved from the Upstox instrument master.')

    const stockKeys = fnoStocks.map(x => x.underlying_key!).filter(Boolean), indexKeys = indexes.map(x => x.instrument?.instrument_key).filter(Boolean) as string[]
    const quotes = await getQuotes([...stockKeys, ...indexKeys], token)
    const liquidStocks = fnoStocks.map(item => { const key = normalizeInstrumentKey(item.underlying_key), quote = quotes[key], last = Number(quote?.last_price ?? 0), volume = Number(quote?.volume ?? 0); return { item, key, quote, liquidity: last * volume } }).filter(x => x.last > 0 || Number(x.quote?.volume ?? 0) > 0).sort((a, b) => b.liquidity - a.liquidity).slice(0, MAX_TECHNICAL_SCAN)

    let historySuccess = 0, historyNoData = 0, historyErrors = 0
    const analyzed = await mapWithConcurrency(liquidStocks, TECHNICAL_CONCURRENCY, async ({ item, key, quote }) => {
      try {
        const candles = await getDailyCandles(key, token)
        if (candles.length < 22) { historyNoData++; return null }
        const t1 = analyzeT1(candles); if (!t1) { historyNoData++; return null }
        historySuccess++
        return { symbol: item.underlying_symbol!, name: item.name || item.underlying_symbol!, sector: 'F&O', ...t1, quoteVolume: Number(quote?.volume ?? 0) }
      } catch { historyErrors++; return null }
    })

    const candidates = analyzed.filter(Boolean).sort((a: any, b: any) => b.score - a.score).slice(0, TOP_RESULTS).map((c: any, index) => ({ ...c, rank: index + 1 }))
    const indexData = indexes.map(item => { const key = normalizeInstrumentKey(item.instrument?.instrument_key), quote = key ? quotes[key] : undefined, lastPrice = quote?.last_price ?? null, netChange = quote?.net_change ?? null, change = lastPrice != null && netChange != null ? changePercent(Number(lastPrice), Number(netChange)) : null; return { title: item.label, value: lastPrice, change } })

    return NextResponse.json({ ok: true, source: 'Upstox live quotes + NSE stock-F&O universe + T-1 historical engine', timestamp: new Date().toISOString(), universeCount, expiry, scannedCount: liquidStocks.length, historySuccess, historyNoData, historyErrors, candidates, indexes: indexData }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Upstox API error'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
