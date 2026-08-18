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
  marketDirection?: string
  marketAligned?: boolean
  openingRangeBreak?: boolean
  extremeVolume?: boolean
  signalTime?: string
  filterDate?: string
}

type IndexQuote = { title: string; value: number | null; change: number | null }
type MarketResponse = { ok: boolean; source?: string; timestamp?: string; candidates?: Candidate[]; indexes?: IndexQuote[]; error?: string; filterDate?: string; diagnostics?: { scanned?: number; candidates?: number; marketHours?: boolean; marketDirection?: string; niftyChange?: number } }
type MoveFilter = 'ALL' | 'UP1' | 'UP2' | 'DOWN1' | 'DOWN2'

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
  const [activeTab, setActiveTab] = useState<'LIVE' | 'HISTORICAL'>('LIVE')
  const [moveFilter, setMoveFilter] = useState<MoveFilter>('ALL')
  const [moveMenu, setMoveMenu] = useState(false)
  const [moveSort, setMoveSort] = useState<'NONE' | 'DESC' | 'ASC'>('NONE')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [historicalCandidates, setHistoricalCandidates] = useState<Candidate[]>([])
  const [indexes, setIndexes] = useState<IndexQuote[]>(fallbackIndexes)
  const [loading, setLoading] = useState(true)
  const [historicalLoading, setHistoricalLoading] = useState(true)
  const [error, setError] = useState('')
  const [historicalError, setHistoricalError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [historicalDate, setHistoricalDate] = useState('')
  const [diagnostics, setDiagnostics] = useState<MarketResponse['diagnostics']>({})
  const [historicalDiagnostics, setHistoricalDiagnostics] = useState<MarketResponse['diagnostics']>({})

  const loadMarketData = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/market', { cache: 'no-store' })
      const data: MarketResponse = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Market data unavailable')
      setCandidates(data.candidates ?? [])
      setIndexes(data.indexes ?? fallbackIndexes)
      setDiagnostics(data.diagnostics ?? {})
      setLastUpdated(data.timestamp ?? new Date().toISOString())
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load market data') }
    finally { setLoading(false) }
  }

  const loadHistoricalData = async () => {
    setHistoricalLoading(true); setHistoricalError('')
    try {
      const response = await fetch('/api/historical', { cache: 'no-store' })
      const data: MarketResponse = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Historical data unavailable')
      setHistoricalCandidates(data.candidates ?? [])
      setHistoricalDate(data.filterDate ?? data.candidates?.[0]?.filterDate ?? '')
      setHistoricalDiagnostics(data.diagnostics ?? {})
    } catch (e) { setHistoricalError(e instanceof Error ? e.message : 'Unable to load historical scan') }
    finally { setHistoricalLoading(false) }
  }

  useEffect(() => {
    loadMarketData(); loadHistoricalData()
    const timer = window.setInterval(loadMarketData, 30000)
    return () => window.clearInterval(timer)
  }, [])

  const activeCandidates = activeTab === 'LIVE' ? candidates : historicalCandidates
  const activeLoading = activeTab === 'LIVE' ? loading : historicalLoading
  const activeError = activeTab === 'LIVE' ? error : historicalError
  const activeDiagnostics = activeTab === 'LIVE' ? diagnostics : historicalDiagnostics
  const filtered = useMemo(() => {
    const rows = activeCandidates.filter(c => {
      const match = `${c.symbol} ${c.name} ${c.sector}`.toLowerCase().includes(query.toLowerCase())
      const bias = (c.bias === 'LONG' && showLong) || (c.bias === 'SHORT' && showShort)
      const move = c.change
      const moveOk = moveFilter === 'ALL' ||
        (moveFilter === 'UP1' && move >= 1) ||
        (moveFilter === 'UP2' && move >= 2) ||
        (moveFilter === 'DOWN1' && move <= -1) ||
        (moveFilter === 'DOWN2' && move <= -2)
      return match && bias && moveOk
    })
    if (moveSort === 'NONE') return rows
    return [...rows].sort((a, b) => moveSort === 'DESC' ? b.change - a.change : a.change - b.change)
  }, [activeCandidates, query, showLong, showShort, moveFilter, moveSort])

  const aPlus = activeCandidates.filter(c => c.score >= 90).length
  const extremeCount = activeCandidates.filter(c => c.extremeVolume).length
  const orbCount = activeCandidates.filter(c => c.openingRangeBreak).length
  const marketDirection = activeDiagnostics?.marketDirection
  const longCount = activeCandidates.filter(c => c.bias === 'LONG').length
  const shortCount = activeCandidates.filter(c => c.bias === 'SHORT').length
  const regime = marketDirection === 'LONG' ? 'BULLISH' : marketDirection === 'SHORT' ? 'BEARISH' : longCount >= shortCount ? 'BULLISH' : 'NEUTRAL'
  const prettyHistoricalDate = historicalDate ? new Date(`${historicalDate}T00:00:00+05:30`).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }).toUpperCase() : 'PREVIOUS SESSION'
  const moveLabel = moveFilter === 'ALL' ? 'MOVE' : moveFilter === 'UP1' ? 'MOVE ≥ +1%' : moveFilter === 'UP2' ? 'MOVE ≥ +2%' : moveFilter === 'DOWN1' ? 'MOVE ≤ -1%' : 'MOVE ≤ -2%'

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><div className="logo">PT</div><div><div className="brand-title">PT MOVE SCANNER</div><div className="brand-sub">Probability-based intraday intelligence</div></div></div>
        <div className="top-actions"><span className="market-status"><i /> Market data: {loading ? 'Connecting…' : error ? 'Offline' : 'LIVE'}</span><span className="date">{lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }).toUpperCase() : '—'}</span><button className="refresh" onClick={() => { loadMarketData(); loadHistoricalData() }}>↻ Refresh</button></div>
      </header>

      <section className="hero">
        <div><div className="eyebrow">{activeTab === 'LIVE' ? 'LIVE → F&O MOMENTUM TERMINAL' : `HISTORICAL → ${prettyHistoricalDate}`}</div><h1>Find the stocks <span>before the move.</span></h1><p>{activeTab === 'LIVE' ? 'Live Upstox data scans the NSE F&O universe for high-volume 5-minute PDH/PDL breaks, opening-range confirmation, relative strength, market direction and NR4/NR7 structure.' : `Historical replay of the same scanner logic for ${prettyHistoricalDate}. These are the stocks that actually passed the configured filters in that session.`}</p></div>
        <div className="regime-card"><div className="small-label">MARKET REGIME</div><div className="regime">{regime} <b>{regime === 'BULLISH' ? '↑' : regime === 'BEARISH' ? '↓' : '→'}</b></div><div className="muted">NIFTY 50 direction confirmation</div></div>
      </section>

      <section className="index-grid">{indexes.map(item => <IndexCard key={item.title} title={item.title} value={item.value == null ? '—' : item.value.toLocaleString('en-IN',{maximumFractionDigits:2})} change={item.change == null ? '—' : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`} positive={(item.change ?? 0) >= 0} />)}</section>

      <section className="control-row">
        <div className="tabs"><button className={activeTab === 'LIVE' ? 'active' : ''} onClick={() => setActiveTab('LIVE')}>LIVE</button><button className={activeTab === 'HISTORICAL' ? 'active' : ''} onClick={() => setActiveTab('HISTORICAL')}>HISTORICAL</button></div>
        <div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stock, sector..." /></div>
        <div className="move-filter-wrap"><button className={`filter move-filter ${moveFilter !== 'ALL' ? 'on' : ''}`} onClick={() => setMoveMenu(v => !v)}>↕ {moveLabel}</button>{moveMenu && <div className="move-menu"><button onClick={() => {setMoveFilter('ALL');setMoveMenu(false)}}>ALL MOVES</button><button onClick={() => {setMoveFilter('UP1');setMoveMenu(false)}}>GAINERS ≥ +1%</button><button onClick={() => {setMoveFilter('UP2');setMoveMenu(false)}}>GAINERS ≥ +2%</button><button onClick={() => {setMoveFilter('DOWN1');setMoveMenu(false)}}>LOSERS ≤ -1%</button><button onClick={() => {setMoveFilter('DOWN2');setMoveMenu(false)}}>LOSERS ≤ -2%</button></div>}</div>
        <button className={`filter ${showLong ? 'on' : ''}`} onClick={() => setShowLong(v => !v)}>● LONG</button><button className={`filter short ${showShort ? 'on' : ''}`} onClick={() => setShowShort(v => !v)}>● SHORT</button>
      </section>

      <section className="stats-row"><Stat label="F&O CANDIDATES" value={String(activeCandidates.length)} note={activeDiagnostics?.scanned ? `${activeDiagnostics.scanned} F&O stocks scanned` : activeTab === 'LIVE' ? 'Live qualified results' : `Filtered on ${prettyHistoricalDate}`} /><Stat label="EXTREME VOLUME" value={String(extremeCount)} note="5m volume ≥ 2.5× average" /><Stat label="OPENING RANGE" value={String(orbCount)} note="15m high/low confirmation" /><Stat label="A+ SETUPS" value={String(aPlus)} note="Model score 90 or above" /></section>

      <section className="content-grid">
        <div className="panel candidates-panel">
          <div className="panel-head"><div><div className="panel-title">{activeTab === 'LIVE' ? 'LIVE F&O MOVE CANDIDATES' : `HISTORICAL FILTERED STOCKS — ${prettyHistoricalDate}`}</div><div className="panel-sub">{activeTab === 'LIVE' ? '5m ≥2× volume + PDH/PDL break + momentum / RS confirmation' : 'Actual previous-session matches • 5m volume + PDH/PDL + ORB + RS + NR4/NR7'}</div></div><span className="live-pill"><i /> {activeLoading ? 'SCANNING' : activeError ? 'ERROR' : activeTab}</span></div>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>STOCK</th><th>SCORE</th><th>BIAS</th><th><button className={`th-button ${moveSort !== 'NONE' ? 'selected' : ''}`} onClick={() => setMoveSort(v => v === 'NONE' ? 'DESC' : v === 'DESC' ? 'ASC' : 'NONE')}>MOVE {moveSort === 'DESC' ? '↓' : moveSort === 'ASC' ? '↑' : '↕'}</button></th><th>RVOL</th><th>REL. STRENGTH</th><th>SETUP</th></tr></thead><tbody>{filtered.map(c => <tr key={c.symbol}><td className="rank">{String(c.rank).padStart(2,'0')}</td><td><div className="stock"><strong>{c.symbol}</strong><span>{c.name}</span></div></td><td><Score value={c.score} /></td><td><span className={`bias ${c.bias.toLowerCase()}`}>{c.bias === 'LONG' ? '↑' : '↓'} {c.bias}</span></td><td className={c.change >= 0 ? 'up' : 'down'}>{c.change > 0 ? '+' : ''}{c.change.toFixed(2)}%</td><td className="volume">{c.rvol?.toFixed(2)}×</td><td>{c.rs}</td><td><span className="setup">{c.setup}</span></td></tr>)}{!activeLoading && !filtered.length && <tr><td colSpan={8} style={{padding:'28px',textAlign:'center'}}>{activeError || (activeTab === 'LIVE' ? 'No live F&O candidates match the confirmation filters right now.' : `No stocks passed the historical filters for ${prettyHistoricalDate}.`)}</td></tr>}</tbody></table></div>
        </div>
        <aside className="panel sector-panel"><div className="panel-head"><div><div className="panel-title">SECTOR LEADERSHIP</div><div className="panel-sub">Relative performance of qualified {activeTab.toLowerCase()} candidates</div></div></div>{sectorRows(activeCandidates).map(([name,score,move]) => <div className="sector" key={name}><div className="sector-top"><span>{name}</span><b>{move}</b></div><div className="bar"><i style={{width:`${score}%`}} /></div><div className="sector-foot"><span>{activeTab === 'LIVE' ? 'Live RS proxy' : 'Historical RS'}</span><span>{score}</span></div></div>)}</aside>
      </section>

      <section className="bottom-grid"><div className="panel signal-panel"><div className="panel-title">{activeTab === 'LIVE' ? 'LIVE SCANNER LOGIC' : 'HISTORICAL REPLAY LOGIC'}</div><div className="logic-grid"><Logic n="01" title="F&O UNIVERSE — ACTIVE" text="NSE stock-futures universe; up to 200 liquid names scanned" /><Logic n="02" title="5M BREAKOUT + VOLUME — ACTIVE" text="PDH/PDL break with ≥2× previous 20-candle volume; ≥2.5× is extreme" /><Logic n="03" title="EARLY-MOVE CONFIRMATION — ACTIVE" text="First 15m range, NIFTY direction and relative strength confirmation" /><Logic n="04" title="STRUCTURE — ACTIVE" text="NR4/NR7 compression and T-1 EMA 5/20 momentum improve ranking" /></div></div><div className="panel disclaimer"><div className="panel-title">MODEL STATUS</div><div className="status-line"><span className="dot" /> {activeError ? 'Connection error' : activeTab === 'LIVE' ? 'Upstox LIVE F&O scanner active' : `Historical replay complete • ${prettyHistoricalDate}`}</div><p>{activeError ? activeError : activeTab === 'LIVE' ? 'Only stocks passing the configured multi-factor confirmation layer are displayed. This is research and decision-support software, not a prediction guarantee or investment advice.' : 'Historical mode re-runs the same scanner conditions against the previous completed trading session so you can see which stocks qualified before the move.'}</p><div className="progress"><i style={{width:'90%'}} /></div><div className="muted">Data connector: UPSTOX LIVE + HISTORICAL</div></div></section>

      <footer><span>PT MOVE SCANNER • {activeTab === 'LIVE' ? 'LIVE ENGINE' : 'HISTORICAL ENGINE'}</span><span>{activeTab === 'LIVE' ? 'Auto-refresh: 30 seconds' : `Previous completed session: ${prettyHistoricalDate}`} • NSE F&amp;O • Research &amp; decision support</span></footer>
    </main>
  )
}

function sectorRows(candidates: Candidate[]): [string,number,string][] { const groups=new Map<string,number[]>(); candidates.forEach(c=>groups.set(c.sector,[...(groups.get(c.sector)??[]),c.change])); return Array.from(groups.entries()).map(([name,changes])=>{const avg=changes.reduce((a,b)=>a+b,0)/changes.length;const score=Math.max(10,Math.min(99,Math.round(50+avg*12)));return [name,score,`${avg>=0?'+':''}${avg.toFixed(2)}%`] as [string,number,string]}).sort((a,b)=>b[1]-a[1]) }
function IndexCard({title,value,change,positive}:{title:string,value:string,change:string,positive?:boolean}) { return <div className="index-card"><div className="small-label">{title}</div><div className="index-value">{value}</div><div className={positive?'up':'down'}>{change}</div><div className="spark"><span/><span/><span/><span/><span/><span/><span/></div></div> }
function Stat({label,value,note}:{label:string,value:string,note:string}) { return <div className="stat"><div className="small-label">{label}</div><div className="stat-value">{value}</div><div className="muted">{note}</div></div> }
function Score({value}:{value:number}) { return <div className="score"><b>{value}</b><span><i style={{width:`${value}%`}} /></span></div> }
function Logic({n,title,text}:{n:string,title:string,text:string}) { return <div className="logic"><span>{n}</span><div><b>{title}</b><p>{text}</p></div></div> }
