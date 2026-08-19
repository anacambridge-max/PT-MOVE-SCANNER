import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2='https://api.upstox.com/v2'
const V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY=6, TOP=100, VOLUME_MULTIPLIER=2, CPR_WIDTH_PCT=0.5

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token:string;symbol:string;last_price:number;volume?:number;net_change?:number;oi?:number}
type C=[string,number,number,number,number,number,number]
type O={prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number};live_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}

const k=(x?:string|null)=>x?.trim().replace('|',':')??''
function date(offset=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)}
const day=(c:C)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))
const ts=(c:C)=>new Date(c[0]).getTime()
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0
function expiry(x?:number|string){if(typeof x==='string'){const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
function cpr(x?:{high:number;low:number;close:number}){if(!x||![x.high,x.low,x.close].every(Number.isFinite))return null;const pivot=(x.high+x.low+x.close)/3,bc=(x.high+x.low)/2,tc=2*pivot-bc,width=Math.abs(tc-bc),pct=pivot?width/pivot*100:Infinity;return{pivot,bc,tc,width,pct,pass:pct<CPR_WIDTH_PCT}}
const bars=(a:C[],d:string)=>a.filter(x=>day(x)===d).sort((a,b)=>ts(a)-ts(b))

async function api(url:string,t:string,label:string){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${t}`},cache:'no-store'});if(r.ok)return await r.json();if(r.status!==429)throw Error(`${label} failed: ${r.status}`);await new Promise(r=>setTimeout(r,600*(i+1)))}throw Error(`${label} failed: 429`)}
async function master(){const r=await fetch(MASTER,{cache:'no-store'});if(!r.ok)throw Error(`Instrument master failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());let s='';try{s=gunzipSync(b).toString()}catch{s=b.toString()}return JSON.parse(s) as I[]}
async function quotes(keys:string[],t:string){const out:Record<string,Q>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V2}/market-quote/quotes`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));const d=(await api(u.toString(),t,'Quotes')).data??{};for(const [z,q] of Object.entries(d) as [string,Q][])out[k(z)]=q,out[k(q.instrument_token)]=q}return out}
async function ohlc(keys:string[],t:string){const out:Record<string,O>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V3}/market-quote/ohlc`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));u.searchParams.set('interval','1d');const d=(await api(u.toString(),t,'Daily OHLC')).data??{};for(const [z,q] of Object.entries(d) as [string,O][])out[k(z)]=q}return out}
async function intraday(key:string,t:string){const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(key)}/minutes/5`,t,'5M intraday');return(d.data?.candles??[]) as C[]}
async function history(key:string,t:string,to:string,from:string){const d=await api(`${V3}/historical-candle/${encodeURIComponent(key)}/minutes/5/${to}/${from}`,t,'5M history');return(d.data?.candles??[]) as C[]}
async function limit<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){const out:R[]=new Array(a.length);let i=0;async function w(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}await Promise.all(Array.from({length:Math.min(n,a.length)},w));return out}

export async function GET(){
 const token=process.env.UPSTOX_ANALYTICS_TOKEN;if(!token)return NextResponse.json({ok:false,error:'UPSTOX_ANALYTICS_TOKEN is not configured'},{status:500})
 try{
  const all=await master(),today=date(),yesterday=date(-1)
  const fut=all.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today)
  const near=[...new Set(fut.map(x=>expiry(x.expiry)).filter(Boolean))].sort()[0]
  const by=new Map<string,I>();for(const x of fut.filter(x=>expiry(x.expiry)===near))by.set(x.underlying_symbol!.toUpperCase(),x)
  const stocks=[...by.values()];if(!stocks.length)throw Error('NSE F&O universe is empty')
  const cashKeys=stocks.map(x=>x.underlying_key!),futureKeys=stocks.map(x=>x.instrument_key)
  const [cashQ,daily,futureQ]=await Promise.all([quotes(cashKeys,token),ohlc(cashKeys,token),quotes(futureKeys,token)])
  const universe=stocks.map(item=>({item,cashKey:k(item.underlying_key),futureKey:k(item.instrument_key),cashQuote:cashQ[k(item.underlying_key)],futureQuote:futureQ[k(item.instrument_key)],ohlc:daily[k(item.underlying_key)]})).filter(x=>x.cashQuote?.last_price>0&&x.futureQuote?.last_price>0)
  const diagnostics={universe:stocks.length,quoteMatched:universe.length,cprPass:0,dailyHighPass:0,cashBars:0,currentCashBreakout:0,futuresChecked:0,futuresBars:0,volumePass:0,breakoutPass:0,finalPass:0,errors:0}

  const cashRows=await limit(universe,CONCURRENCY,async u=>{try{return{...u,cashBars:bars(await intraday(u.cashKey,token),today)}}catch{diagnostics.errors++;return{...u,cashBars:[] as C[]}}})
  const pre=cashRows.filter(u=>{
   const prevH=u.ohlc?.prev_ohlc?.high??NaN,prevL=u.ohlc?.prev_ohlc?.low??NaN,prevC=u.ohlc?.prev_ohlc?.close??NaN
   const z=cpr({high:prevH,low:prevL,close:prevC});if(!z?.pass)return false;diagnostics.cprPass++
   if(!u.cashBars.length)return false;diagnostics.cashBars++
   const dh=Math.max(...u.cashBars.map(x=>+x[2]),u.ohlc?.live_ohlc?.high??0);if(!(dh>50))return false;diagnostics.dailyHighPass++
   const cur=u.cashBars[u.cashBars.length-1],up=+cur[2]>prevH,dn=+cur[3]<prevL;if(!up&&!dn)return false;diagnostics.currentCashBreakout++;return true
  })

  const rows=await limit(pre,CONCURRENCY,async({item,futureKey,cashQuote,futureQuote,ohlc,cashBars})=>{try{
   diagnostics.futuresChecked++;const fb=bars(await intraday(futureKey,token),today);if(!fb.length)return null;diagnostics.futuresBars++
   const cur=fb[fb.length-1],prev=fb.filter(x=>ts(x)<ts(cur));let h=[...prev]
   if(h.length<19){const old=await history(futureKey,token,yesterday,date(-30));h=[...old.filter(x=>day(x)<today),...h].sort((a,b)=>ts(a)-ts(b))}
   const p19=h.slice(-19).map(x=>+x[5]||0);if(p19.length<19)return null
   const v=+cur[5]||0,sma=avg([...p19,v]);if(!(sma>0&&v>sma*VOLUME_MULTIPLIER))return null;diagnostics.volumePass++
   const cc=cashBars[cashBars.length-1],ph=ohlc?.prev_ohlc?.high??NaN,pl=ohlc?.prev_ohlc?.low??NaN,pc=ohlc?.prev_ohlc?.close??NaN,up=+cc[2]>ph,dn=+cc[3]<pl;if(!up&&!dn)return null;diagnostics.breakoutPass++
   const z=cpr({high:ph,low:pl,close:pc})!,dh=Math.max(...cashBars.map(x=>+x[2]),ohlc?.live_ohlc?.high??0);diagnostics.finalPass++
   return{rank:0,symbol:item.underlying_symbol!.toUpperCase(),name:item.name||item.trading_symbol||item.underlying_symbol!,bias:up?'LONG':'SHORT',change:Number(cashQuote.net_change??0),lastPrice:cashQuote.last_price,futurePrice:futureQuote.last_price,rvol:+(v/sma).toFixed(2),volume:v,avgVolume20:+sma.toFixed(0),breakout:up?'PDH BREAK':'PDL BREAK',signalTime:cur[0],score:100,setup:`5M FUT VOL > 2× SMA20 + ${up?'PDH':'PDL'} BREAK + NARROW CPR`,cpr:z,cprWidth:+z.pct.toFixed(3),dailyHigh:+dh.toFixed(2),prevDayHigh:ph,prevDayLow:pl,conditions:{futuresVolume:true,cashBreakout:true,dailyHighAbove50:true,narrowCPR:true}}
  }catch{diagnostics.errors++;return null}})
  const candidates=rows.filter(Boolean).sort((a:any,b:any)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()).slice(0,TOP).map((x:any,i)=>({...x,rank:i+1}))

  const indexKeys=['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank','NSE_INDEX|Nifty Midcap 100','NSE_INDEX|India VIX'];const indexQ=await quotes(indexKeys,token)
  const labels=['NIFTY 50','BANK NIFTY','NIFTY MIDCAP','INDIA VIX'];const indexes=indexKeys.map((ik,i)=>{const q=indexQ[k(ik)];const ch=q?.last_price&&q?.net_change!=null?q.net_change/(q.last_price-q.net_change)*100:null;return{title:labels[i],value:q?.last_price??null,change:ch}})
  return NextResponse.json({ok:true,source:'UPSTOX • EXACT FILTER SCANNER',timestamp:new Date().toISOString(),universeCount:stocks.length,scanned:universe.length,candidates,expiry:near,indexes,diagnostics,filter:{all:true,volumeMultiplier:2,cprWidthPct:.5,volume:'5M FUTURES Volume > 2 × 5M SMA(Volume,20)',cash:'5M CASH High > previous day High OR 5M CASH Low < previous day Low',dailyHigh:'Current Daily High > 50',cpr:'Previous-day CPR width / Pivot < 0.5%'}})
 }catch(e:any){return NextResponse.json({ok:false,error:e?.message||'Market scan failed'},{status:500})}
}
