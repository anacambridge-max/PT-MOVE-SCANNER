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
type MarketResponse = { ok: boolean; source?: string; timestamp?: string; candidates?: Candidate[]; indexes?: IndexQuote[]; error?: string; diagnostics?: { scanned?: number; candidates?: number; marketHours?: boolean } }

const fallbackIndexes: IndexQuote[] = [
  { title: 'NIFTY 50', value: null, change: null },
  { title: 'BANK NIFTY', value: null, change: null },
  { title: 'NIFTY MIDCAP', value: null, change: null },
  { title: 'INDIA VIX', value: null, change: null },
]

export default function Home() {
  const [query, setQuery] = useState('')
  const [showLong, setShowLong] = useState(true)
  const [showShort, setShowShort] = useState(true)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [indexes, setIndexes] = useState<IndexQuote[]>(fallbackIndexes)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [diagnostics, setDiagnostics] = useState<MarketResponse['diagnostics']>({})

  const loadMarketData = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/market', { cache: 'no-store' })
      const data: MarketResponse = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Market data unavailable')
      setCandidates(data.candidates ?? [])
      setIndexes(data.indexes ?? fallbackIndexes)
      setDiagnostics(data.diagnostics ?? {})
      setLastUpdated(data.timestamp ?? new Date().toISOString())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load market data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMarketData()
    const timer = window.setInterval(loadMarketData, 30000)
    return () => window.clearInterval(timer)
  }, [])

  const filtered = useMemo(() => candidates.filter(c => {
    const match = `${c.symbol} ${c.name} ${c.sector}`.toLowerCase().includes(query.toLowerCase())
    const bias = (c.bias === 'LONG' && showLong) || (c.bias === 'SHORT' && showShort)
    return match && bias
  }), [candidates, query, showLong, showShort])

  const aPlus = candidates.filter(c => c.score >= 90).length
  const longCount = candidates.filter(c => c.bias === 'LONG').length
  const shortCount = candidates.filter(c => c.bias === 'SHORT').length
  const regime = longCount >= shortCount ? 'BULLISH' : 'BEARISH'

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
          <div className="eyebrow">LIVE → INTRADAY INTELLIGENCE TERMINAL</div>
          <h1>Find the stocks <span>before the move.</span></h1>
          <p>Live Upstox market data scans NSE F&amp;O stocks for high-volume 5-minute breakouts of Previous Day High/Low, with momentum, NR4/NR7 and T-1 confirmation.</p>
        </div>
        <div className="regime-card"><div className="small-label">MARKET REGIME</div><div className="regime">{regime} <b>{regime === 'BULLISH' ? '↑' : '↓'}</b></div><div className="muted">Based on current scanner direction</div></div>
      </section>

      <section className="index-grid">
        {indexes.map((item) => <IndexCard key={item.title} title={item.title} value={item.value == null ? '—' : item.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} change={item.change == null ? '—' : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`} positive={(item.change ?? 0) >= 0} />)}
      </section>

      <section className="control-row">
        <div className="tabs"><button className="active">LIVE</button></div>
        <div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stock, sector..." /></div>
        <button className={`filter ${showLong ? 'on' : ''}`} onClick={() => setShowLong(v => !v)}>● LONG</button>
        <button className={`filter short ${showShort ? 'on' : ''}`} onClick={() => setShowShort(v => !v)}>● SHORT</button>
      </section>

      <section className="stats-row">
        <Stat label="LIVE CANDIDATES" value={String(candidates.length)} note={diagnostics?.scanned ? `${diagnostics.scanned} F&O stocks scanned` : 'Live scanner results'} />
        <Stat label="LONG SETUPS" value={String(longCount)} note="PDH breakout direction" />
        <Stat label="SHORT SETUPS" value={String(shortCount)} note="PDL breakdown direction" />
        <Stat label="A+ SETUPS" value={String(aPlus)} note="Active model score 90 or above" />
      </section>

      <section className="content-grid">
        <div className="panel candidates-panel">
          <div className="panel-head"><div><div className="panel-title">LIVE MOVE CANDIDATES</div><div className="panel-sub">5m volume &gt; 2× previous 20-candle average + PDH/PDL breakout</div></div><span className="live-pill"><i /> {loading ? 'CONNECTING' : error ? 'ERROR' : 'LIVE'}</span></div>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>STOCK</th><th>SCORE</th><th>BIAS</th><th>MOVE</th><th>VOLUME</th><th>REL. STRENGTH</th><th>SETUP</th></tr></thead><tbody>{filtered.map(c => <tr key={c.symbol}><td className="rank">{String(c.rank).padStart(2,'0')}</td><td><div className="stock"><strong>{c.symbol}</strong><span>{c.name}</span></div></td><td><Score value={c.score} /></td><td><span className={`bias ${c.bias.toLowerCase()}`}>{c.bias === 'LONG' ? '↑' : '↓'} {c.bias}</span></td><td className={c.change >= 0 ? 'up' : 'down'}>{c.change > 0 ? '+' : ''}{c.change.toFixed(2)}%</td><td className="volume">{c.volume}</td><td>{c.rs}</td><td><span className="setup">{c.setup}</span></td></tr>)}{!loading && !filtered.length && <tr><td colSpan={8} style={{padding:'28px', textAlign:'center'}}>{error || 'No live candidates match the current filter.'}</td></tr>}</tbody></table></div>
        </div>

        <aside className="panel sector-panel"><div className="panel-head"><div><div className="panel-title">SECTOR LEADERSHIP</div><div className="panel-sub">Average move across live scanner candidates</div></div></div>{sectorRows(candidates).map(([name, score, move]) => <div className="sector" key={name}><div className="sector-top"><span>{name}</span><b>{move}</b></div><div className="bar"><i style={{width: `${score}%`}} /></div><div className="sector-foot"><span>Live RS proxy</span><span>{score}</span></div></div>)}</aside>
      </section>

      <section className="bottom-grid">
        <div className="panel signal-panel"><div className="panel-title">LIVE SCANNER LOGIC</div><div className="logic-grid"><Logic n="01" title="Live Market Data — ACTIVE" text="Upstox live quotes, price, volume and index data" /><Logic n="02" title="5-Minute Breakout — ACTIVE" text="Volume > 2× previous 20-candle average + PDH/PDL break" /><Logic n="03" title="Momentum Confirmation — ACTIVE" text="T-1 trend, 5/20 momentum, NR4/NR7 and relative strength" /><Logic n="04" title="F&O Universe — ACTIVE" text="Scans the current NSE F&O stock universe" /></div></div>
        <div className="panel disclaimer"><div className="panel-title">MODEL STATUS</div><div className="status-line"><span className="dot" /> {error ? 'Connection error' : 'Upstox LIVE scanner active'}</div><p>{error ? error : 'The LIVE layer identifies stocks matching the configured technical conditions. It is a research and decision-support tool, not a prediction guarantee or investment advice.'}</p><div className="progress"><i style={{width: '85%'}} /></div><div className="muted">Data connector: {error ? 'ERROR' : 'UPSTOX LIVE + HISTORICAL'}</div></div>
      </section>

      <footer><span>PT MOVE SCANNER • LIVE ENGINE</span><span>Auto-refresh: 30 seconds • Research &amp; decision support</span></footer>
    </main>
  )
}

function sectorRows(candidates: Candidate[]): [string, number, string][] {
  const groups = new Map<string, number[]>()
  candidates.forEach(c => groups.set(c.sector, [...(groups.get(c.sector) ?? []), c.change]))
  return Array.from(groups.entries()).map(([name, changes]) => { const avg = changes.reduce((a,b) => a+b, 0) / changes.length; const score = Math.max(10, Math.min(99, Math.round(50 + avg * 12))); return [name, score, `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`] as [string,number,string] }).sort((a,b) => b[1]-a[1])
}

function IndexCard({title,value,change,positive}:{title:string,value:string,change:string,positive?:boolean}) { return <div className="index-card"><div className="small-label">{title}</div><div className="index-value">{value}</div><div className={positive ? 'up' : 'down'}>{change}</div><div className="spark"><span/><span/><span/><span/><span/><span/><span/></div></div> }
function Stat({label,value,note}:{label:string,value:string,note:string}) { return <div className="stat"><div className="small-label">{label}</div><div className="stat-value">{value}</div><div className="muted">{note}</div></div> }
function Score({value}:{value:number}) { return <div className="score"><b>{value}</b><span><i style={{width:`${value}%`}} /></span></div> }
function Logic({n,title,text}:{n:string,title:string,text:string}) { return <div className="logic"><span>{n}</span><div><b>{title}</b><p>{text}</p></div></div> }
