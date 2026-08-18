import { NextResponse } from 'next/server'

const API_V2 = 'https://api.upstox.com/v2'
const API_V3 = 'https://api.upstox.com/v3'

const stockQueries = [
  ['BEL', 'Bharat Electronics', 'Defence'],
  ['TRENT', 'Trent Ltd', 'Retail'],
  ['BHEL', 'Bharat Heavy Electricals', 'Capital Goods'],
  ['HAL', 'Hindustan Aeronautics', 'Defence'],
  ['TATASTEEL', 'Tata Steel', 'Metals'],
  ['ADANIENT', 'Adani Enterprises', 'Conglomerate'],
] as const

const indexQueries = [
  ['NIFTY 50', 'NIFTY 50'],
  ['BANKNIFTY', 'BANK NIFTY'],
  ['NIFTY MIDCAP 100', 'NIFTY MIDCAP'],
  ['INDIA VIX', 'INDIA VIX'],
] as const

type Instrument = {
  instrument_key: string
  trading_symbol?: string
  name?: string
  segment?: string
}

type Quote = {
  instrument_token: string
  symbol: string
  last_price: number
  volume?: number
  net_change?: number
  average_price?: number
  oi?: number
  oi_day_high?: number
  oi_day_low?: number
}

type Candle = [string, number, number, number, number, number, number]

function normalizeInstrumentKey(key?: string | null) {
  return key?.trim().replace('|', ':') ?? ''
}

function changePercent(lastPrice: number, netChange: number) {
  const previousClose = lastPrice - netChange
  if (!Number.isFinite(previousClose) || previousClose === 0) return 0
  return (netChange / previousClose) * 100
}

function indiaDate(offsetDays = 0) {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  const d = Number(parts.find(p => p.type === 'day')?.value)
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays))
  return date.toISOString().slice(0, 10)
}

async function searchInstrument(query: string, segment: 'EQ' | 'INDEX', token: string) {
  const url = new URL(`${API_V2}/instruments/search`)
  url.searchParams.set('query', query)
  url.searchParams.set('exchanges', 'NSE')
  url.searchParams.set('segments', segment)
  url.searchParams.set('records', '10')
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Instrument search failed: ${response.status}`)
  const body = await response.json()
  const data: Instrument[] = body.data ?? []
  return data.find(item =>
    item.trading_symbol?.toUpperCase() === query.toUpperCase() ||
    item.name?.toUpperCase() === query.toUpperCase()
  ) ?? data[0]
}

async function getQuotes(keys: string[], token: string) {
  if (!keys.length) return {} as Record<string, Quote>
  const url = new URL(`${API_V2}/market-quote/quotes`)
  url.searchParams.set('instrument_key', keys.join(','))
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Market quote failed: ${response.status}`)
  const body = await response.json()
  const rawData = (body.data ?? {}) as Record<string, Quote>
  const quotes: Record<string, Quote> = {}
  for (const [returnedKey, quote] of Object.entries(rawData)) {
    const normalized = normalizeInstrumentKey(returnedKey)
    if (normalized) quotes[normalized] = quote
    const tokenKey = normalizeInstrumentKey(quote.instrument_token)
    if (tokenKey) quotes[tokenKey] = quote
  }
  return quotes
}

async function getDailyCandles(instrumentKey: string, token: string): Promise<Candle[]> {
  const to = indiaDate(-1)
  const from = indiaDate(-90)
  const encodedKey = encodeURIComponent(instrumentKey)
  const url = `${API_V3}/historical-candle/${encodedKey}/days/1/${to}/${from}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Historical candle failed: ${response.status}`)
  const body = await response.json()
  return (body.data?.candles ?? []) as Candle[]
}

function avg(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function ema(values: number[], period: number) {
  if (!values.length) return 0
  const k = 2 / (period + 1)
  let result = values[0]
  for (let i = 1; i < values.length; i++) result = values[i] * k + result * (1 - k)
  return result
}

function analyzeT1(candlesRaw: Candle[]) {
  const candles = [...candlesRaw].sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
  if (candles.length < 22) return null

  const i = candles.length - 1
  const c = candles[i]
  const prev = candles[i - 1]
  const close = Number(c[4])
  const open = Number(c[1])
  const high = Number(c[2])
  const low = Number(c[3])
  const volume = Number(c[5] ?? 0)
  const range = Math.max(0, high - low)
  const prevHigh = Number(prev[2])
  const prevLow = Number(prev[3])
  const prevClose = Number(prev[4])
  const priorRanges = candles.slice(Math.max(0, i - 20), i).map(x => Number(x[2]) - Number(x[3]))
  const priorVolumes = candles.slice(Math.max(0, i - 20), i).map(x => Number(x[5] ?? 0))
  const avgRange = avg(priorRanges)
  const avgVolume = avg(priorVolumes)
  const closes = candles.map(x => Number(x[4]))
  const ema5 = ema(closes.slice(-40), 5)
  const ema20 = ema(closes.slice(-40), 20)
  const rangesForNr = candles.slice(Math.max(0, i - 7), i + 1).map(x => Number(x[2]) - Number(x[3]))
  const nr4 = range <= Math.min(...rangesForNr.slice(-4))
  const nr7 = range <= Math.min(...rangesForNr.slice(-7))
  const rangePct = close ? (range / close) * 100 : 0
  const dayChange = prevClose ? ((close - prevClose) / prevClose) * 100 : 0
  const rvol = avgVolume ? volume / avgVolume : 1
  const rangeExpansion = avgRange ? range / avgRange : 1
  const closeLocation = range ? (close - low) / range : 0.5
  const bodyPct = range ? Math.abs(close - open) / range : 0
  const momentum5 = candles.length > 5 && Number(candles[i - 5][4]) ? ((close / Number(candles[i - 5][4])) - 1) * 100 : 0
  const momentum20 = candles.length > 20 && Number(candles[i - 20][4]) ? ((close / Number(candles[i - 20][4])) - 1) * 100 : 0
  const high20 = Math.max(...candles.slice(Math.max(0, i - 20), i).map(x => Number(x[2])))
  const low20 = Math.min(...candles.slice(Math.max(0, i - 20), i).map(x => Number(x[3])))
  const breakoutUp = close > high20
  const breakoutDown = close < low20

  let longScore = 0
  let shortScore = 0
  const signals: string[] = []

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

  const bias = longScore >= shortScore ? 'LONG' : 'SHORT'
  const rawScore = Math.max(longScore, shortScore)
  const score = Math.max(50, Math.min(99, rawScore + 45))
  const setup = signals.length ? signals.slice(0, 2).join(' + ') : 'Structure watch'
  const confidence = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B+' : 'B'

  return {
    score,
    bias,
    change: dayChange,
    volume: volume ? volume.toLocaleString('en-IN') : '—',
    rs: bias === 'LONG' ? (momentum5 > 1 ? 'Strong' : 'Positive') : (momentum5 < -1 ? 'Weak' : 'Negative'),
    setup,
    confidence,
    lastPrice: close,
    oi: null,
    rvol: Number(rvol.toFixed(2)),
    rangePct: Number(rangePct.toFixed(2)),
    nr4,
    nr7,
    pdBreak: breakoutUp ? 'PDH' : breakoutDown ? 'PDL' : '—',
    t1Date: c[0],
  }
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN
  if (!token) return NextResponse.json({ ok: false, error: 'UPSTOX_ANALYTICS_TOKEN is not configured' }, { status: 500 })

  try {
    const [stocks, indexes] = await Promise.all([
      Promise.all(stockQueries.map(async ([query, name, sector]) => ({
        query, name, sector, instrument: await searchInstrument(query, 'EQ', token)
      }))),
      Promise.all(indexQueries.map(async ([query, label]) => ({
        query, label, instrument: await searchInstrument(query, 'INDEX', token)
      }))),
    ])

    const stockKeys = stocks.map(x => x.instrument?.instrument_key).filter(Boolean) as string[]
    const indexKeys = indexes.map(x => x.instrument?.instrument_key).filter(Boolean) as string[]
    const quotes = await getQuotes([...stockKeys, ...indexKeys], token)

    const analyzed = await Promise.all(stocks.map(async (item, index) => {
      const key = item.instrument?.instrument_key
      if (!key) return null
      const candles = await getDailyCandles(key, token)
      const t1 = analyzeT1(candles)
      if (!t1) return null
      return {
        rank: index + 1,
        symbol: item.query,
        name: item.name,
        sector: item.sector,
        ...t1,
      }
    }))

    const candidates = analyzed.filter(Boolean).sort((a: any, b: any) => b.score - a.score).map((c: any, index) => ({ ...c, rank: index + 1 }))

    const indexData = indexes.map(item => {
      const key = normalizeInstrumentKey(item.instrument?.instrument_key)
      const quote = key ? quotes[key] : undefined
      const lastPrice = quote?.last_price ?? null
      const netChange = quote?.net_change ?? null
      const change = lastPrice != null && netChange != null ? changePercent(Number(lastPrice), Number(netChange)) : null
      return { title: item.label, value: lastPrice, change }
    })

    return NextResponse.json({
      ok: true,
      source: 'Upstox Analytics Token + Historical T-1 Engine',
      timestamp: new Date().toISOString(),
      candidates,
      indexes: indexData,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Upstox API error'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
