import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration = 60
const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY=5,TOP=100,MULT=2,START='09:15'

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token?:string;symbol?:string;last_price:number;net_change?:number}
type C=[string,number,number,number,number,number,number]
type O={prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}
const clean=(x?:string|null)=>x?.trim().replace('|',':')??''
const t=(c:C)=>new Date(c[0]).getTime()
function date(off=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+off)).toISOString().slice(0,10)}
const day=(c:C)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))
const hm=(c:C)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(c[0]))
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0
function expiry(x?:number|string){if(typeof x==='string'){const z=Date.parse(x);return Number.isFinite(z)?new Date(z).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
async function api(url:string,token:string,label:string){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${token}`},cache:'no-store'});if(r.ok)return r.json();if(r.status!==429)throw Error(`${label} failed: ${r.status}`);await new Promise(r=>setTimeout(r,600*(i+1)))}throw Error(`${label} failed: 429`)}
async function master(){const r=await fetch(MASTER,{cache:'no-store'});if(!r.ok)throw Error(`Instrument master failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());let s='';try{s=gunzipSync(b).toString()}catch{s=b.toString()}return JSON.parse(s) as I[]}
async function quotes(keys:string[],token:string){const out:Record<string,Q>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V2}/market-quote/quotes`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));const d=(await api(u.toString(),token,'Quotes')).data??{};for(const [k,q] of Object.entries(d) as [string,Q][]) {out[clean(k)]=q;if(q.instrument_token)out[clean(q.instrument_token)]=q;if(q.symbol)out[q.symbol.toUpperCase()]=q}}return out}
async function daily(keys:string[],token:string){const out:Record<string,O>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V3}/market-quote/ohlc`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));u.searchParams.set('interval','1d');const d=(await api(u.toString(),token,'Daily OHLC')).data??{};for(const [k,q] of Object.entries(d) as [string,O][])out[clean(k)]=q}return out}
async function intra(key:string,token:string){const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`,token,'5M intraday');return (d.data?.candles??[]) as C[]}
async function hist(key:string,token:string){try{const d=await api(`${V3}/historical-candle/${encodeURIComponent(key)}/minutes/5/${date(-1)}/${date(-7)}`,token,'5M history');return (d.data?.candles??[]) as C[]}catch{return []}}
async function limit<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){const out:R[]=new Array(a.length);let i=0;async function w(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}await Promise.all(Array.from({length:Math.min(n,a.length)},w));return out}

export async function GET(){
 const token=process.env.UPSTOX_ANALYTICS_TOKEN||process.env.UPSTOX_ACCESS_TOKEN
 if(!token)return NextResponse.json({ok:false,error:'Upstox token is not configured'},{status:500})
 try{
  const today=date(),all=await master()
  const fut=all.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today)
  const near=[...new Set(fut.map(x=>expiry(x.expiry)).filter(Boolean))].sort()[0]
  const by=new Map<string,I>();for(const x of fut.filter(x=>expiry(x.expiry)===near))by.set(x.underlying_symbol!.toUpperCase(),x)
  const stocks=[...by.values()];if(!stocks.length)throw Error('NSE F&O universe is empty')
  const cashKeys=stocks.map(x=>x.underlying_key!),futureKeys=stocks.map(x=>x.instrument_key)
  const [cq,fq,pd]=await Promise.all([quotes(cashKeys,token),quotes(futureKeys,token),daily(cashKeys,token)])
  const universe=stocks.map(item=>{const ck=clean(item.underlying_key),fk=clean(item.instrument_key);return{item,ck,fk,cash:cq[ck]||cq[item.underlying_symbol!.toUpperCase()],future:fq[fk]||fq[(item.trading_symbol||'').toUpperCase()],prev:pd[ck]?.prev_ohlc}}).filter(x=>x.cash?.last_price>0&&x.future?.last_price>0&&x.prev)
  const diagnostics={universe:stocks.length,quoteMatched:universe.length,cashBars:0,futuresBars:0,dailyHighPass:0,cashBreakoutPass:0,volumePass:0,finalPass:0,errors:0}

  // First scan only the CASH series. This reduces Upstox calls and identifies every
  // 5M candle today that could qualify. We then inspect futures only for candidates.
  const cashHits=await limit(universe,CONCURRENCY,async x=>{try{
   const bars=(await intra(x.ck,token)).filter(c=>day(c)===today&&hm(c)>=START).sort((a,b)=>t(a)-t(b));diagnostics.cashBars+=bars.length;if(!bars.length)return null
   let dayHigh=0;const hits:any[]=[]
   for(const c of bars){dayHigh=Math.max(dayHigh,Number(c[2])||0);if(dayHigh>50){diagnostics.dailyHighPass++;const up=Number(c[2])>x.prev!.high,dn=Number(c[3])<x.prev!.low;if(up||dn){diagnostics.cashBreakoutPass++;hits.push({c,up,dn,dayHigh})}}}
   return hits.length?{...x,hits}:null
  }catch{diagnostics.errors++;return null}})
  const candidatesCash=cashHits.filter(Boolean) as any[]

  const rows=await limit(candidatesCash,CONCURRENCY,async x=>{try{
   const [fbRaw,hRaw]=await Promise.all([intra(x.fk,token),hist(x.fk,token)])
   const fb=fbRaw.filter(c=>day(c)===today&&hm(c)>=START).sort((a,b)=>t(a)-t(b));diagnostics.futuresBars+=fb.length;if(!fb.length)return null
   const allF=[...hRaw.filter(c=>day(c)!==today),...fb].sort((a,b)=>t(a)-t(b));const fBy=new Map(fb.map(c=>[t(c),c]))
   const qualified:any[]=[]
   for(const h of x.hits){const f=fBy.get(t(h.c));if(!f)continue;const idx=allF.findIndex(c=>t(c)===t(f));if(idx<19)continue;const win=allF.slice(idx-19,idx+1).map(c=>Number(c[5])||0),sma=avg(win),vol=Number(f[5])||0;if(sma>0&&vol>sma*MULT)qualified.push({f,h,rvol:vol/sma,sma})}
   if(!qualified.length)return null
   diagnostics.volumePass+=qualified.length;diagnostics.finalPass++
   const hit=qualified[qualified.length-1]
   return {rank:0,symbol:x.item.underlying_symbol!.toUpperCase(),name:x.item.name||x.item.trading_symbol||x.item.underlying_symbol!,bias:hit.h.up?'LONG':'SHORT',change:Number(x.cash.net_change??0),lastPrice:Number(x.cash.last_price),futurePrice:Number(x.future.last_price),rvol:+hit.rvol.toFixed(2),volume:Number(hit.f[5])||0,avgVolume20:Math.round(hit.sma),breakout:hit.h.up?'PDH BREAK':'PDL BREAK',signalTime:hit.h.c[0],score:100,setup:`TODAY 09:15+ • 5M FUTURES VOLUME > 2× SMA(20) + ${hit.h.up?'5M HIGH > 1 DAY AGO HIGH':'5M LOW < 1 DAY AGO LOW'} + DAILY HIGH > 50`,dailyHigh:+hit.h.dayHigh.toFixed(2),prevDayHigh:Number(x.prev.high),prevDayLow:Number(x.prev.low),conditions:{futuresVolume:true,cashBreakout:true,dailyHighAbove50:true}}
  }catch{diagnostics.errors++;return null}})
  const candidates=rows.filter(Boolean).sort((a:any,b:any)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()).slice(0,TOP).map((x:any,i)=>({...x,rank:i+1}))
  const ik=['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank','NSE_INDEX|Nifty Midcap 100','NSE_INDEX|India VIX'],iq=await quotes(ik,token),labels=['NIFTY 50','BANK NIFTY','NIFTY MIDCAP','INDIA VIX']
  const indexes=ik.map((k,i)=>{const q=iq[clean(k)]||iq[labels[i]];const ch=q?.last_price&&q.net_change!=null?q.net_change/(q.last_price-q.net_change)*100:null;return{title:labels[i],value:q?.last_price??null,change:ch}})
  return NextResponse.json({ok:true,source:'UPSTOX • TODAY 09:15+ LIVE SIGNAL HISTORY',timestamp:new Date().toISOString(),sessionStart:START,universeCount:stocks.length,scanned:universe.length,candidates,expiry:near,indexes,diagnostics,filter:{all:true,filters:3,volumeMultiplier:2,volume:'5 MINUTE Volume > 5 MINUTE SMA(Volume,20) × 2',cash:'5 MINUTE High > 1 DAY AGO High OR 5 MINUTE Low < 1 DAY AGO Low',dailyHigh:'Daily High > 50',history:'ALL qualifying signals from today 09:15 onward are retained; latest signal shown per stock'}})
 }catch(e:any){return NextResponse.json({ok:false,error:e?.message||'Market scan failed'},{status:500})}
}
