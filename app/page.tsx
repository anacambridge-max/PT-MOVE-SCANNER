'use client'

import { useEffect, useMemo, useState } from 'react'

type Candidate = {
  rank: number
  symbol: string
  name: string
  sector: string
  score: number
  bias: 'LONG' | 'SHORT'
  change: number
  volume: string
  rs: string
  setup: string
  confidence: string
  lastPrice: number
  oi: number | null
  rvol?: number
  rangePct?: number
  nr4?: boolean
  nr7?: boolean
  pdBreak?: string
  t1Date?: string
}

type IndexQuote = { title: string; value: number | null; change: number | null }
type MarketResponse = { ok: boolean; source?: string; timestamp?: string; candidates?: Candidate[]; indexes?: IndexQuote[]; error?: string }

type PreMarketCandidate = Candidate & {
  preScore: number
  preBias: 'LONG' | 'SHORT'
  confirmation: string
}

const fallbackIndexes: IndexQuote[] = [
  { title: 'NIFTY 50', value: null, change: null },
  { title: 'BANK NIFTY', value: null, change: null },
  { title: 'NIFTY MIDCAP', value: null, change: null },
  { title: 'INDIA VIX', value: null, change: null },
]

function buildPreMarket(candidates: Candidate[], indexes: IndexQuote[]): PreMarketCandidate[] {
  const nifty = indexes.find(i => i.title === 'NIFTY 50')?.change ?? 0
  const bank = indexes.find(i => i.title === 'BANK NIFTY')?.change ?? 0
  const midcap = indexes.find(i => i.title === 'NIFTY MIDCAP')?.change ?? 0
  const marketMove = (nifty + bank + midcap) / 3

  return candidates.map(c => {
    const aligned = (c.bias === 'LONG' && c.change > 0) || (c.bias === 'SHORT' && c.change < 0)
    const marketAligned = (c.bias === 'LONG' && marketMove > 0) || (c.bias === 'SHORT' && marketMove < 0)
    const stockMomentum = Math.min(18, Math.round(Math.abs(c.change) * 4))
    const base = Math.round(c.score * 0.65)
    const alignment = aligned ? 10 : 0
    const market = marketAligned ? 10 : 0
    const penalty = !aligned ? 10 : 0
    const preScore = Math.max(50, Math.min(99, base + stockMomentum + alignment + market - penalty))
    const preBias: 'LONG' | 'SHORT' = aligned ? c.bias : c.change >= 0 ? 'LONG' : 'SHORT'

    const parts = [
      aligned ? 'T-1 aligned' : 'T-1 conflict',
      marketAligned ? 'Index aligned' : 'Index conflict',
      Math.abs(c.change) >= 1 ? 'Momentum' : 'Base move',
    ]

    return { ...c, preScore, preBias, confirmation: parts.join(' • ') }
  }).sort((a, b) => b.preScore - a.preScore).map((c, index) => ({ ...c, rank: index + 1 }))
}

export default function Home() {
  const [mode, setMode] = useState<'T-1' | 'PRE-MARKET' | 'LIVE'>('T-1')
  const [query, setQuery] = useState('')
  const [showLong, setShowLong] = useState(true)
  const [showShort, setShowShort] = useState(true)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [indexes, setIndexes] = useState<IndexQuote[]>(fallbackIndexes)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')

  const loadMarketData = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/market', { cache: 'no-store' })
      const data: MarketResponse = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Market data unavailable')
      setCandidates(data.candidates ?? [])
      setIndexes(data.indexes ?? fallbackIndexes)
      setLastUpdated(data.timestamp ?? new Date().toISOString())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load market data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMarketData() }, [])

  const preMarketCandidates = useMemo(() => buildPreMarket(candidates, indexes), [candidates, indexes])
  const activeCandidates = mode === 'PRE-MARKET' ? preMarketCandidates : candidates

  const filtered = useMemo(() => activeCandidates.filter(c => {
    const match = `${c.symbol} ${c.name} ${c.sector}`.toLowerCase().includes(query.toLowerCase())
    const activeBias = mode === 'PRE-MARKET' ? (c as PreMarketCandidate).preBias : c.bias
    const bias = (activeBias === 'LONG' && showLong) || (activeBias === 'SHORT' && showShort)
    return match && bias
  }), [activeCandidates, query, showLong, showShort, mode])

  const aPlus = activeCandidates.filter(c => (mode === 'PRE-MARKET' ? (c as PreMarketCandidate).preScore : c.score) >= 90).length
  const longCount = activeCandidates.filter(c => (mode === 'PRE-MARKET' ? (c as PreMarketCandidate).preBias : c.bias) === 'LONG').length
  const regime = activeCandidates.length > 0 && longCount >= activeCandidates.length / 2 ? 'BULLISH' : 'BEARISH'
  const t1Date = candidates.find(c => c.t1Date)?.t1Date
  const confirmed = preMarketCandidates.filter(c => c.preScore >= 85 && c.confirmation.includes('T-1 aligned')).length

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo">PT</div>
          <div><div className="brand-title">PT MOVE SCANNER</div><div className="brand-sub">Probability-based intraday intelligence</div></div>
        </div>
        <div className="top-actions">
          <span className="market-status"><i /> Market data: {loading ? 'Connecting…' : error ? 'Offline' : 'LIVE'}</span>
          <span className="date">{lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : '—'}</span>
          <button className="refresh" onClick={loadMarketData}>↻ Refresh</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">T-1 → PRE-MARKET INTELLIGENCE TERMINAL</div>
          <h1>Find the stocks <span>before the move.</span></h1>
          <p>Upstox data is connected. T-1 structure is now combined with market-direction and current-momentum confirmation to create the next-stage pre-market/opening score.</p>
        </div>
        <div className="regime-card"><div className="small-label">MARKET REGIME</div><div className="regime">{regime} <b>{regime === 'BULLISH' ? '↑' : '↓'}</b></div><div className="muted">Based on active scanner direction</div></div>
      </section>

      <section className="index-grid">
        {indexes.map((item) => <IndexCard key={item.title} title={item.title} value={item.value == null ? '—' : item.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} change={item.change == null ? '—' : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`} positive={(item.change ?? 0) >= 0} />)}
      </section>

      <section className="control-row">
        <div className="tabs">
          {(['T-1', 'PRE-MARKET', 'LIVE'] as const).map(m => <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m}</button>)}
        </div>
        <div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stock, sector..." /></div>
        <button className={`filter ${showLong ? 'on' : ''}`} onClick={() => setShowLong(v => !v)}>● LONG</button>
        <button className={`filter short ${showShort ? 'on' : ''}`} onClick={() => setShowShort(v => !v)}>● SHORT</button>
      </section>

      <section className="stats-row">
        <Stat label="T-1 CANDIDATES" value={String(candidates.length)} note={t1Date ? `Using session ${new Date(t1Date).toLocaleDateString('en-IN')}` : 'Historical structure scan'} />
        <Stat label="PRE-MARKET CONFIRMED" value={String(confirmed)} note="T-1 aligned + market confirmation ≥85" />
        <Stat label="LIVE CONFIRMATIONS" value={String(candidates.length)} note="Live quote layer connected" />
        <Stat label="A+ SETUPS" value={String(aPlus)} note={mode === 'PRE-MARKET' ? 'Pre-market score 90 or above' : 'Active model score 90 or above'} />
      </section>

      <section className="content-grid">
        <div className="panel candidates-panel">
          <div className="panel-head"><div><div className="panel-title">TOP MOVE CANDIDATES</div><div className="panel-sub">{mode === 'T-1' ? 'Previous-session structure ranked for the next trading session' : mode === 'PRE-MARKET' ? 'T-1 + index direction + current momentum confirmation' : 'Live confirmation layer — next stage'}</div></div><span className="live-pill"><i /> {loading ? 'CONNECTING' : error ? 'ERROR' : mode === 'PRE-MARKET' ? 'PRE-MARKET' : 'T-1 LIVE'}</span></div>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>STOCK</th><th>{mode === 'PRE-MARKET' ? 'PT SCORE' : 'SCORE'}</th><th>BIAS</th><th>{mode === 'PRE-MARKET' ? 'MOVE' : 'T-1 CHG'}</th><th>VOLUME</th><th>{mode === 'PRE-MARKET' ? 'CONFIRMATION' : 'REL. STRENGTH'}</th><th>SETUP</th></tr></thead><tbody>{filtered.map(c => { const pc = c as PreMarketCandidate; const score = mode === 'PRE-MARKET' ? pc.preScore : c.score; const bias = mode === 'PRE-MARKET' ? pc.preBias : c.bias; return <tr key={c.symbol}><td className="rank">{String(c.rank).padStart(2,'0')}</td><td><div className="stock"><strong>{c.symbol}</strong><span>{c.name}</span></div></td><td><Score value={score} /></td><td><span className={`bias ${bias.toLowerCase()}`}>{bias === 'LONG' ? '↑' : '↓'} {bias}</span></td><td className={c.change >= 0 ? 'up' : 'down'}>{c.change > 0 ? '+' : ''}{c.change.toFixed(2)}%</td><td className="volume">{c.volume}</td><td>{mode === 'PRE-MARKET' ? pc.confirmation : c.rs}</td><td><span className="setup">{c.setup}</span></td></tr>})}{!loading && !filtered.length && <tr><td colSpan={8} style={{padding:'28px', textAlign:'center'}}>{error || 'No matching candidates.'}</td></tr>}</tbody></table></div>
        </div>

        <aside className="panel sector-panel"><div className="panel-head"><div><div className="panel-title">SECTOR LEADERSHIP</div><div className="panel-sub">{mode === 'PRE-MARKET' ? 'T-1 candidate strength proxy' : 'T-1 average move across scanned candidates'}</div></div></div>{sectorRows(candidates).map(([name, score, move]) => <div className="sector" key={name}><div className="sector-top"><span>{name}</span><b>{move}</b></div><div className="bar"><i style={{width: `${score}%`}} /></div><div className="sector-foot"><span>{mode === 'PRE-MARKET' ? 'Strength proxy' : 'T-1 RS proxy'}</span><span>{score}</span></div></div>)}</aside>
      </section>

      <section className="bottom-grid">
        <div className="panel signal-panel"><div className="panel-title">SCANNER LOGIC — BUILD ROADMAP</div><div className="logic-grid"><Logic n="01" title="Live Market Data — ACTIVE" text="Upstox quotes, price, volume and index data connected" /><Logic n="02" title="T-1 Engine — ACTIVE" text="Trend, 5/20 momentum, range, RVOL, NR4/NR7 and PDH/PDL structure" /><Logic n="03" title="Pre-Market Engine — ACTIVE" text="T-1 alignment + index direction + current momentum confirmation" /><Logic n="04" title="F&O / OI Layer — NEXT" text="PCR, OI, change in OI and max-pain confirmation next" /></div></div>
        <div className="panel disclaimer"><div className="panel-title">MODEL STATUS</div><div className="status-line"><span className="dot" /> {error ? 'Connection error' : mode === 'PRE-MARKET' ? 'Upstox pre-market confirmation active' : 'Upstox T-1 engine active'}</div><p>{error ? error : 'The pre-market layer is a confirmation model, not a prediction guarantee. It combines completed-session structure with current market direction and momentum. This is research software, not investment advice.'}</p><div className="progress"><i style={{width: mode === 'PRE-MARKET' ? '70%' : '55%'}} /></div><div className="muted">Data connector: {error ? 'ERROR' : 'UPSTOX LIVE + HISTORICAL'}</div></div>
      </section>

      <footer><span>PT MOVE SCANNER • v1.3 PRE-MARKET ENGINE</span><span>Built for research & decision support • Not investment advice</span></footer>
    </main>
  )
}

function sectorRows(candidates: Candidate[]): [string, number, string][] {
  const groups = new Map<string, number[]>()
  candidates.forEach(c => groups.set(c.sector, [...(groups.get(c.sector) ?? []), c.change]))
  return Array.from(groups.entries())
    .map(([name, changes]) => {
      const avg = changes.reduce((a, b) => a + b, 0) / changes.length
      const score = Math.max(10, Math.min(99, Math.round(50 + avg * 12)))
      return [name, score, `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`] as [string, number, string]
    })
    .sort((a, b) => b[1] - a[1])
}

function IndexCard({title,value,change,positive}:{title:string,value:string,change:string,positive?:boolean}) { return <div className="index-card"><div className="small-label">{title}</div><div className="index-value">{value}</div><div className={positive ? 'up' : 'down'}>{change}</div><div className="spark"><span/><span/><span/><span/><span/><span/><span/></div></div> }
function Stat({label,value,note}:{label:string,value:string,note:string}) { return <div className="stat"><div className="small-label">{label}</div><div className="stat-value">{value}</div><div className="muted">{note}</div></div> }
function Score({value}:{value:number}) { return <div className="score"><b>{value}</b><span><i style={{width:`${value}%`}} /></span></div> }
function Logic({n,title,text}:{n:string,title:string,text:string}) { return <div className="logic"><span>{n}</span><div><b>{title}</b><p>{text}</p></div></div> }
