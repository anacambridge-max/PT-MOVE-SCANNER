'use client'

import { useMemo, useState } from 'react'

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
}

const candidates: Candidate[] = [
  { rank: 1, symbol: 'BEL', name: 'Bharat Electronics', sector: 'Defence', score: 94, bias: 'LONG', change: 1.84, volume: '3.2×', rs: 'Strong', setup: 'Breakout watch', confidence: 'A+' },
  { rank: 2, symbol: 'TRENT', name: 'Trent Ltd', sector: 'Retail', score: 91, bias: 'LONG', change: 1.42, volume: '2.7×', rs: 'Strong', setup: 'Demand expansion', confidence: 'A+' },
  { rank: 3, symbol: 'BHEL', name: 'Bharat Heavy Electricals', sector: 'Capital Goods', score: 88, bias: 'LONG', change: 1.18, volume: '2.4×', rs: 'Strong', setup: 'Range expansion', confidence: 'A' },
  { rank: 4, symbol: 'HAL', name: 'Hindustan Aeronautics', sector: 'Defence', score: 86, bias: 'LONG', change: 0.96, volume: '2.1×', rs: 'Positive', setup: 'Compression break', confidence: 'A' },
  { rank: 5, symbol: 'TATASTEEL', name: 'Tata Steel', sector: 'Metals', score: 84, bias: 'SHORT', change: -1.16, volume: '2.0×', rs: 'Weak', setup: 'Supply rejection', confidence: 'A' },
  { rank: 6, symbol: 'ADANIENT', name: 'Adani Enterprises', sector: 'Conglomerate', score: 81, bias: 'SHORT', change: -0.84, volume: '1.8×', rs: 'Weak', setup: 'Breakdown watch', confidence: 'B+' },
]

const sectors = [
  ['Defence', 92, '+1.9%'], ['Capital Goods', 87, '+1.3%'], ['Retail', 81, '+0.9%'],
  ['Metals', 62, '-0.6%'], ['IT', 54, '+0.1%'], ['Pharma', 48, '-0.2%'],
]

export default function Home() {
  const [mode, setMode] = useState<'T-1' | 'PRE-MARKET' | 'LIVE'>('T-1')
  const [query, setQuery] = useState('')
  const [showLong, setShowLong] = useState(true)
  const [showShort, setShowShort] = useState(true)

  const filtered = useMemo(() => candidates.filter(c => {
    const match = `${c.symbol} ${c.name} ${c.sector}`.toLowerCase().includes(query.toLowerCase())
    const bias = (c.bias === 'LONG' && showLong) || (c.bias === 'SHORT' && showShort)
    return match && bias
  }), [query, showLong, showShort])

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo">PT</div>
          <div><div className="brand-title">PT MOVE SCANNER</div><div className="brand-sub">Probability-based intraday intelligence</div></div>
        </div>
        <div className="top-actions">
          <span className="market-status"><i /> Market data: Demo</span>
          <span className="date">14 AUG 2026</span>
          <button className="refresh" onClick={() => location.reload()}>↻ Refresh</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">PRE-MARKET INTELLIGENCE TERMINAL</div>
          <h1>Find the stocks <span>before the move.</span></h1>
          <p>Ranked candidates using structure, relative strength, volume, volatility, sector context and derivatives-ready signals.</p>
        </div>
        <div className="regime-card"><div className="small-label">MARKET REGIME</div><div className="regime">BULLISH <b>↑</b></div><div className="muted">NIFTY leadership intact</div></div>
      </section>

      <section className="index-grid">
        <IndexCard title="NIFTY 50" value="24,718.60" change="+0.62%" positive />
        <IndexCard title="BANK NIFTY" value="55,286.40" change="+0.44%" positive />
        <IndexCard title="NIFTY MIDCAP" value="58,931.20" change="+0.81%" positive />
        <IndexCard title="INDIA VIX" value="13.84" change="-2.10%" positive />
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
        <Stat label="T-1 CANDIDATES" value="23" note="Potential next-day movers" />
        <Stat label="PRE-MARKET CONFIRMED" value="11" note="Surviving early filter" />
        <Stat label="LIVE CONFIRMATIONS" value="4" note="Price + volume confirmation" />
        <Stat label="A+ SETUPS" value="6" note="Score 90 or above" />
      </section>

      <section className="content-grid">
        <div className="panel candidates-panel">
          <div className="panel-head"><div><div className="panel-title">TOP MOVE CANDIDATES</div><div className="panel-sub">{mode === 'T-1' ? 'Prepared from previous-session conditions' : mode === 'PRE-MARKET' ? 'Early-session confirmation layer' : 'Live confirmation layer'}</div></div><span className="live-pill"><i /> SCANNING</span></div>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>STOCK</th><th>SCORE</th><th>BIAS</th><th>CHANGE</th><th>VOLUME</th><th>REL. STRENGTH</th><th>SETUP</th></tr></thead><tbody>{filtered.map(c => <tr key={c.symbol}><td className="rank">{String(c.rank).padStart(2,'0')}</td><td><div className="stock"><strong>{c.symbol}</strong><span>{c.name}</span></div></td><td><Score value={c.score} /></td><td><span className={`bias ${c.bias.toLowerCase()}`}>{c.bias === 'LONG' ? '↑' : '↓'} {c.bias}</span></td><td className={c.change >= 0 ? 'up' : 'down'}>{c.change > 0 ? '+' : ''}{c.change.toFixed(2)}%</td><td className="volume">{c.volume}</td><td>{c.rs}</td><td><span className="setup">{c.setup}</span></td></tr>)}</tbody></table></div>
        </div>

        <aside className="panel sector-panel"><div className="panel-head"><div><div className="panel-title">SECTOR LEADERSHIP</div><div className="panel-sub">Relative strength map</div></div></div>{sectors.map(([name, score, move]) => <div className="sector" key={name}><div className="sector-top"><span>{name}</span><b>{move}</b></div><div className="bar"><i style={{width: `${score}%`}} /></div><div className="sector-foot"><span>RS score</span><span>{score}</span></div></div>)}</aside>
      </section>

      <section className="bottom-grid">
        <div className="panel signal-panel"><div className="panel-title">SCANNER LOGIC</div><div className="logic-grid"><Logic n="01" title="Price Structure" text="Compression, breakout and rejection context" /><Logic n="02" title="Relative Strength" text="Stock vs NIFTY and sector leadership" /><Logic n="03" title="Volume / Volatility" text="Participation and expansion detection" /><Logic n="04" title="F&O / OI Ready" text="Architecture prepared for derivatives feed" /></div></div>
        <div className="panel disclaimer"><div className="panel-title">MODEL STATUS</div><div className="status-line"><span className="dot" /> Demo scoring layer active</div><p>Current candidates are demonstration data. Connect an authorised market-data provider before using this terminal for live decisions. A score indicates probability, not certainty.</p><div className="progress"><i /></div><div className="muted">Data connector: NOT CONFIGURED</div></div>
      </section>

      <footer><span>PT MOVE SCANNER • v1.0</span><span>Built for research & decision support • Not investment advice</span></footer>
    </main>
  )
}

function IndexCard({title,value,change,positive}:{title:string,value:string,change:string,positive?:boolean}) { return <div className="index-card"><div className="small-label">{title}</div><div className="index-value">{value}</div><div className={positive ? 'up' : 'down'}>{change}</div><div className="spark"><span/><span/><span/><span/><span/><span/><span/></div></div> }
function Stat({label,value,note}:{label:string,value:string,note:string}) { return <div className="stat"><div className="small-label">{label}</div><div className="stat-value">{value}</div><div className="muted">{note}</div></div> }
function Score({value}:{value:number}) { return <div className="score"><b>{value}</b><span><i style={{width:`${value}%`}} /></span></div> }
function Logic({n,title,text}:{n:string,title:string,text:string}) { return <div className="logic"><span>{n}</span><div><b>{title}</b><p>{text}</p></div></div> }
