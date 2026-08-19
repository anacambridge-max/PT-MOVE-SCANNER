import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY=6,TOP=100
const VOLUME_MULTIPLIER=2
const CPR_WIDTH_PCT=0.5

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token:string;symbol:string;last_price:number;volume?:number;net_change?:number;oi?:number}
type C=[string,number,number,number,number,number,number]
type O={prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number};live_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}

function key(x?:string|null){return x?.trim().replace('|',':')??''}
function date(offset=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)}
function day(c:C){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function expiry(x?:number|string){if(typeof x==='string'){const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
async function api(url:string,t:string,label:string){let last=0;for(let attempt=0;attempt<4;attempt++){const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${t}`},cache:'no-store'});if(r.ok)return await r.json();last=r.status;if(r.status!==429)throw Error(`${label} failed: ${r.status}`);await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)))}throw Error(`${label} failed: ${last}`)}
async function instrumentMaster(){const r=await fetch(MASTER,{cache:'no-store'});if(!r.ok)throw Error(`Instrument master failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());let s='';try{s=gunzipSync(b).toString()}catch{s=b.toString()}return JSON.parse(s) as I[]}
async function quotes(keys:string[],t:string){const out:Record<string,Q>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V2}/market-quote/quotes`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));const d=(await api(u.toString(),t,'Quotes')).data??{};for(const [k,q] of Object.entries(d) as [string,Q][])out[key(k)]=q,out[key(q.instrument_token)]=q}return out}
async function dailyOHLC(keys:string[],t:string){const out:Record<string,O>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V3}/market-quote/ohlc`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));u.searchParams.set('interval','1d');const d=(await api(u.toString(),t,'Daily OHLC')).data??{};for(const [k,q] of Object.entries(d) as [string,O][])out[key(k)]=q}return out}
async function historical(k:string,t:string,unit:'minutes',interval:number,to:string,from:string){const u=`${V3}/historical-candle/${encodeURIComponent(k)}/${unit}/${interval}/${to}/${from}`;const d=await api(u,t,'5M history');return(d.data?.candles??[]) as C[]}
async function intraday(k:string,t:string){const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/5`,t,'5M intraday');return(d.data?.candles??[]) as C[]}
async function mapLimit<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){const out:R[]=new Array(a.length);let i=0;async function worker(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}await Promise.all(Array.from({length:Math.min(n,a.length)},worker));return out}
function narrowCPR(prev?:{high:number;low:number;close:number}){if(!prev)return null;const p=(prev.high+prev.low+prev.close)/3,bc=(prev.high+prev.low)/2,tc=2*p-bc;const width=Math.abs(tc-bc),pct=p?width/p*100:Infinity;return{pivot:p,bc,tc,width,pct,pass:pct<CPR_WIDTH_PCT}}
function dayBars(a:C[],d:string){return a.filter(c=>day(c)===d).sort((x,y)=>new Date(x[0]).getTime()-new Date(y[0]).getTime())}

export async function GET(){
 const token=process.env.UPSTOX_ANALYTICS_TOKEN
 if(!token)return NextResponse.json({ok:false,error:'UPSTOX_ANALYTICS_TOKEN is not configured'},{status:500})
 try{
  const all=await instrumentMaster(),today=date(),prev=date(-1)
  const futures=all.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today)
  const near=Array.from(new Set(futures.map(x=>expiry(x.expiry)).filter(Boolean))).sort()[0]
  const bySymbol=new Map<string,I>();for(const x of futures.filter(x=>expiry(x.expiry)===near))bySymbol.set(x.underlying_symbol!.toUpperCase(),x)
  const stocks=[...bySymbol.values()];if(!stocks.length)throw Error('NSE F&O universe is empty')
  const cashKeys=stocks.map(x=>x.underlying_key!),futureKeys=stocks.map(x=>x.instrument_key)
  const [cashQuotes,cashOHLC,futureQuotes]=await Promise.all([quotes(cashKeys,token),dailyOHLC(cashKeys,token),quotes(futureKeys,token)])
  const universe=stocks.map(item=>({item,cashKey:key(item.underlying_key),futureKey:key(item.instrument_key),cashQuote:cashQuotes[key(item.underlying_key)],futureQuote:futureQuotes[key(item.instrument_key)],ohlc:cashOHLC[key(item.underlying_key)]})).filter(x=>x.cashQuote?.last_price>0&&x.futureQuote?.last_price>0)
  const rows=await mapLimit(universe,CONCURRENCY,async({item,cashKey,futureKey,cashQuote,futureQuote,ohlc})=>{try{
    const prevH=ohlc?.prev_ohlc?.high??NaN,prevL=ohlc?.prev_ohlc?.low??NaN,prevC=ohlc?.prev_ohlc?.close??NaN
    const cpr=narrowCPR({high:prevH,low:prevL,close:prevC});if(!cpr?.pass)return null
    const [futureToday,futureHistory,cashToday]=await Promise.all([intraday(futureKey,token),historical(futureKey,token,'minutes',5,prev,date(-15)),intraday(cashKey,token)])
    const fBars=dayBars(futureToday,today),fHist=futureHistory.filter(c=>day(c)<today).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime()),cBars=dayBars(cashToday,today)
    if(!fBars.length||!cBars.length)return null
    const currentDailyHigh=Math.max(...cBars.map(c=>+c[2]),ohlc?.live_ohlc?.high??0)
    if(!(currentDailyHigh>50))return null
    let signal:any=null
    for(const f of fBars){
      const ts=new Date(f[0]).getTime(),cash=cBars.find(c=>Math.abs(new Date(c[0]).getTime()-ts)<60*1000)
      if(!cash)continue
      const history=[...fHist,...fBars.filter(x=>new Date(x[0]).getTime()<ts)].sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())
      const idx=history.length
      const vols=history.slice(Math.max(0,idx-20),idx).map(c=>+c[5]||0)
      const sma20=avg(vols);const fv=+f[5]||0;const volumePass=sma20>0&&fv>sma20*VOLUME_MULTIPLIER
      const breakoutHigh=+cash[2]>prevH,breakoutLow=+cash[3]<prevL
      if(!volumePass||(!breakoutHigh&&!breakoutLow))continue
      const direction=breakoutHigh?'LONG':'SHORT'
      signal={time:f[0],direction,volume:fv,sma20,rvol:sma20?fv/sma20:0,breakout:breakoutHigh?'PDH BREAK':'PDL BREAK',price:cashQuote.last_price,futurePrice:futureQuote.last_price,cashHigh:+cash[2],cashLow:+cash[3]}
    }
    if(!signal)return null
    return {rank:0,symbol:item.underlying_symbol!.toUpperCase(),name:item.name||item.trading_symbol||item.underlying_symbol!,bias:signal.direction,change:Number(cashQuote.net_change??0),lastPrice:cashQuote.last_price,futurePrice:futureQuote.last_price,rvol:+signal.rvol.toFixed(2),volume:signal.volume,avgVolume20:+signal.sma20.toFixed(0),breakout:signal.breakout,signalTime:signal.time,score:100,setup:`5M FUT VOL > 2× SMA20 + ${signal.breakout} + NARROW CPR`,cpr:cpr,cprWidth:+cpr.pct.toFixed(3),dailyHigh:+currentDailyHigh.toFixed(2),prevDayHigh:prevH,prevDayLow:prevL,conditions:{futuresVolume:true,cashBreakout:true,dailyHighAbove50:true,narrowCPR:true}}
   }catch{return null}})
  const candidates=rows.filter(Boolean).sort((a:any,b:any)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()).slice(0,TOP).map((x:any,i)=>({...x,rank:i+1}))
  const indexQueries=[['NIFTY 50','NIFTY 50'],['BANKNIFTY','BANK NIFTY'],['NIFTY MIDCAP 100','NIFTY MIDCAP'],['INDIA VIX','INDIA VIX']]
  const indexes=await Promise.all(indexQueries.map(async([query,label])=>{try{const u=new URL(`${V2}/instruments/search`);u.searchParams.set('query',query);u.searchParams.set('exchanges','NSE');u.searchParams.set('segments','INDEX');u.searchParams.set('records','10');const found=((await api(u.toString(),token,'Index search')).data??[] as I[]).find(x=>x.trading_symbol?.toUpperCase()===query.toUpperCase()||x.name?.toUpperCase()===query.toUpperCase());if(!found)return{title:label,value:null,change:null};const q=(await quotes([found.instrument_key],token))[key(found.instrument_key)];return{title:label,value:q?.last_price??null,change:q?.last_price&&q?.net_change!=null?q.net_change/(q.last_price-q.net_change)*100:null}}catch{return{title:label,value:null,change:null}}}))
  return NextResponse.json({ok:true,source:'UPSTOX • EXACT FILTER SCANNER',timestamp:new Date().toISOString(),universeCount:stocks.length,scanned:universe.length,candidates,expiry:near,indexes,diagnostics:{futuresVolume:'5M futures Volume > 2 × SMA(Volume,20)',cashBreakout:'5M cash High > previous day High OR 5M cash Low < previous day Low',dailyHigh:'Current Daily High > 50',narrowCPR:`Previous-day CPR width < ${CPR_WIDTH_PCT}% of Pivot`,matched:candidates.length},filter:{all:true,volumeMultiplier:VOLUME_MULTIPLIER,cprWidthPct:CPR_WIDTH_PCT}})
 }catch(e:any){return NextResponse.json({ok:false,error:e?.message||'Market scan failed'},{status:500})}
}
