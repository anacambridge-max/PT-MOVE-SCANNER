import { NextResponse } from 'next/server'

const API = 'https://api.upstox.com/v2'

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

function normalizeInstrumentKey(key?: string | null) {
  return key?.trim().replace('|', ':') ?? ''
}

async function searchInstrument(query: string, segment: 'EQ' | 'INDEX', token: string) {
  const url = new URL(`${API}/instruments/search`)
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

  return data.find((item) =>
    item.trading_symbol?.toUpperCase() === query.toUpperCase() ||
    item.name?.toUpperCase() === query.toUpperCase()
  ) ?? data[0]
}

async function getQuotes(keys: string[], token: string[]) {
  if (!keys.length) return {} as Record<string, Quote>

  const url = new URL(`${API}/market-quote/quotes`)
  url.searchParams.set('instrument_key', keys.join(','))

  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token[0]}` },
    cache: 'no-store',
  })

  if (!response.ok) throw new Error(`Market quote failed: ${response.status}`)
  const body = await response.json()
  const rawData = (body.data ?? {}) as Record<string, Quote>
  const quotes: Record<string, Quote> = {}

  // Upstox may return the instrument key in colon format (NSE_EQ:...) while
  // the instrument-search endpoint returns pipe format (NSE_EQ|...).
  // Store both normalized aliases so quote lookup is reliable.
  for (const [returnedKey, quote] of Object.entries(rawData)) {
    const normalizedReturnedKey = normalizeInstrumentKey(returnedKey)
    if (normalizedReturnedKey) quotes[normalizedReturnedKey] = quote

    const tokenKey = normalizeInstrumentKey(quote.instrument_token)
    if (tokenKey) quotes[tokenKey] = quote
  }

  return quotes
}

export async function GET() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN

  if (!token) {
    return NextResponse.json({ ok: false, error: 'UPSTOX_ANALYTICS_TOKEN is not configured' }, { status: 500 })
  }

  try {
    const [stocks, indexes] = await Promise.all([
      Promise.all(stockQueries.map(async ([query, name, sector]) => ({
        query,
        name,
        sector,
        instrument: await searchInstrument(query, 'EQ', token),
      }))),
      Promise.all(indexQueries.map(async ([query, label]) => ({
        query,
        label,
        instrument: await searchInstrument(query, 'INDEX', token),
      }))),
    ])

    const stockKeys = stocks
      .map((item) => item.instrument?.instrument_key)
      .filter(Boolean) as string[]
    const indexKeys = indexes
      .map((item) => item.instrument?.instrument_key)
      .filter(Boolean) as string[]

    const quotes = await getQuotes([...stockKeys, ...indexKeys], [token])

    const candidates = stocks.flatMap((item, index) => {
      const key = normalizeInstrumentKey(item.instrument?.instrument_key)
      if (!key) return []

      const quote = quotes[key]
      if (!quote) return []

      const change = Number(quote.net_change ?? 0)
      const score = Math.max(50, Math.min(99, Math.round(70 + Math.abs(change) * 10)))
      const bias = change >= 0 ? 'LONG' : 'SHORT'
      const volume = quote.volume ? `${quote.volume.toLocaleString('en-IN')}` : '—'

      return [{
        rank: index + 1,
        symbol: item.query,
        name: item.name,
        sector: item.sector,
        score,
        bias,
        change,
        volume,
        rs: change > 1 ? 'Strong' : change > 0 ? 'Positive' : change < -1 ? 'Weak' : 'Neutral',
        setup: Math.abs(change) >= 1.5 ? 'Expansion watch' : Math.abs(change) >= 0.75 ? 'Momentum watch' : 'Base watch',
        confidence: score >= 90 ? 'A+' : score >= 80 ? 'A' : 'B+',
        lastPrice: quote.last_price,
        oi: quote.oi ?? null,
      }]
    })

    const indexData = indexes.map((item) => {
      const key = normalizeInstrumentKey(item.instrument?.instrument_key)
      const quote = key ? quotes[key] : undefined
      return {
        title: item.label,
        value: quote?.last_price ?? null,
        change: quote?.net_change ?? null,
      }
    })

    return NextResponse.json({
      ok: true,
      source: 'Upstox Analytics Token',
      timestamp: new Date().toISOString(),
      candidates,
      indexes: indexData,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Upstox API error'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
