import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY=8,TOP=30,EXTREME_MULTIPLE=2.5

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token:string;symbol:string;last_price:number;volume?:number;net_change?:number;oi?:number}
type C=[string,number,number,number,number,number,number]
type O={prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number};live_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}

function key(x?:string|null){return x?.trim().replace('|',':')??''}
function date(offset=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)}
function dayOf(c:C){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function completed(c:C[]){const now=Date.now();return c.filter(x=>new Date(x[0]).getTime()+5*60*1000<=now).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())}
function expiry(x?:number|string){if(typeof x==='string'){const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
async function api(url:string,t:string,label:string){let last=0;for(let attempt=0;attempt<4;attempt++){const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${t}`},cache:'no-store'});if(r.ok)return await r.json();last=r.status;if(r.status!==429)throw Error(`${label} failed: ${r.status}`);await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)))}throw Error(`${label} failed: ${last}`)}
async function instrumentMaster(){const r=await fetch(MASTER,{cache:'no-store'});if(!r.ok)throw Error(`Instrument master failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());let s='';try{s=gunzipSync(b).toString()}catch{s=b.toString()}return JSON.parse(s) as I[]}
async function quotes(keys:string[],t:string){const out:Record<string,Q>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V2}/market-quote/quotes`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));const d=(await api(u.toString(),t,'Quotes')).data??{};for(const [k,q] of Object.entries(d) as [string,Q][])out[key(k)]=q,out[key(q.instrument_token)]=q}return out}
async function daily(keys:string[],t:string){const out:Record<string,O>={};for(let i=0;i<keys.length;i+=500){const u=new URL(`${V3}/market-quote/ohlc`);u.searchParams.set('instrument_key',keys.slice(i,i+500).join(','));u.searchParams.set('interval','1d');const d=(await api(u.toString(),t,'Daily OHLC')).data??{};for(const [k,q] of Object.entries(d) as [string,O][])out[key(k)]=q}return out}
async function fiveMin(k:string,t:string){const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/5`,t,'5M candles');return(d.data?.candles??[]) as C[]}
async function historicalFiveMin(k:string,t:string){const d=await api(`${V3}/historical-candle/${encodeURIComponent(k)}/minutes/5/${date(-1)}/${date(-7)}`,t,'Historical 5M');return(d.data?.candles??[]) as C[]}
async function oneMin(k:string,t:string){const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/1`,t,'1M candles');return(d.data?.candles??[]) as C[]}
async function mapLimit<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){const out:R[]=new Array(a.length);let i=0;async function worker(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}await Promise.all(Array.from({length:Math.min(n,a.length)},worker));return out}
function signalFrom5M(sessionRaw:C[],history:C[],pdh:number,pdl:number,live:number){const session=[...sessionRaw].sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime());const done=completed(session),old=completed(history).filter(c=>dayOf(c)<date());let best:any=null;for(const c of session){const ts=new Date(c[0]).getTime(),forming=ts+300000>Date.now(),before=[...old,...done.filter(x=>new Date(x[0]).getTime()<ts)].slice(-20),base=avg(before.map(x=>+x[5]||0)),vol=+c[5]||0;if(before.length<20||!base||vol/base<EXTREME_MULTIPLE)continue;const price=forming?live:+c[4],hi=Math.max(+c[2],forming?live:+c[2]),lo=Math.min(+c[3],forming?live:+c[3]),long=price>pdh&&hi>pdh,short=price<pdl&&lo<pdl;if(!long&&!short)continue;best={vr:vol/base,direction:long?'LONG':'SHORT',pdBreak:long?'PDH':'PDL',candleTime:c[0],forming}}return best}
function current5M(one:C[],pdh:number,pdl:number,price:number,history:C[],session:C[]){if(!one.length||!price)return null;const bucket=Math.floor(Date.now()/300000)*300000,rows=one.filter(c=>{const t=new Date(c[0]).getTime();return t>=bucket&&t<bucket+300000});if(!rows.length)return null;const vol=rows.reduce((s,c)=>s+(+c[5]||0),0),old=completed(history).filter(c=>dayOf(c)<date()),done=completed(session),before=done.length>=20?done.slice(-20):[...old,...done].slice(-20),base=avg(before.map(c=>+c[5]||0));if(before.length<20||!base||vol/base<EXTREME_MULTIPLE)return null;const hi=Math.max(price,...rows.map(c=>+c[2]||0)),lo=Math.min(price,...rows.map(c=>+c[3]||0)),long=price>pdh&&hi>pdh,short=price<pdl&&lo<pdl;if(!long&&!short)return null;return{vr:vol/base,direction:long?'LONG':'SHORT',pdBreak:long?'PDH':'PDL',candleTime:new Date(bucket).toISOString(),forming:true}}

export async function GET(){
 const token=process.env.UPSTOX_ANALYTICS_TOKEN
 if(!token)return NextResponse.json({ok:false,error:'UPSTOX_ANALYTICS_TOKEN is not configured'},{status:500})
 try{
  const all=await instrumentMaster(),today=date()
  const futures=all.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today)
  const near=[...new Set(futures.map(x=>expiry(x.expiry)).filter(Boolean))].sort()[0]
  const m=new Map<string,I>();for(const x of futures.filter(x=>expiry(x.expiry)===near))m.set(x.underlying_symbol!.toUpperCase(),x)
  const stocks=[...m.values()];if(!stocks.length)throw Error('NSE F&O universe is empty')
  const stockKeys=stocks.map(x=>x.underlying_key!),[qs,oh]=await Promise.all([quotes(stockKeys,token),daily(stockKeys,token)])
  const universe=stocks.map(item=>({item,key:key(item.underlying_key),quote:qs[key(item.underlying_key)],ohlc:oh[key(item.underlying_key)]})).filter(x=>x.quote?.last_price>0)

  // IMPORTANT: filter on TODAY'S HIGH/LOW, not only the current price.
  // A stock may have broken PDH/PDL with extreme volume and then returned inside the range.
  // Such a stock must still remain a candidate for today's scan.
  const scanPool=universe.filter(x=>{
    const h=x.ohlc?.prev_ohlc?.high,l=x.ohlc?.prev_ohlc?.low,todayHigh=x.ohlc?.live_ohlc?.high,todayLow=x.ohlc?.live_ohlc?.low
    return Number.isFinite(h)&&Number.isFinite(l)&&Number.isFinite(todayHigh)&&Number.isFinite(todayLow)&&(todayHigh!>h!||todayLow!<l!)
  })

  let intradaySuccess=0,intradayErrors=0,triggerCount=0,liveFallbackChecks=0,liveFallbackHits=0
  const rows=await mapLimit(scanPool,CONCURRENCY,async({item,key,quote,ohlc})=>{try{
   const pdh=ohlc!.prev_ohlc!.high,pdl=ohlc!.prev_ohlc!.low
   const session=await fiveMin(key,token)
   // Always get recent prior 5M history when the current session is too short to provide
   // a complete 20-candle baseline. This makes the scanner work from the opening session too.
   let history:C[]=completed(session).length<20?await historicalFiveMin(key,token):[]
   let f=signalFrom5M(session,history,pdh,pdl,quote.last_price)
   if(!f){liveFallbackChecks++;const one=await oneMin(key,token);const fb=current5M(one,pdh,pdl,quote.last_price,history,session);if(fb){f=fb;liveFallbackHits++}}
   intradaySuccess++;if(!f)return null;triggerCount++
   const score=Math.min(99,Math.round(60+Math.min(25,(f.vr-EXTREME_MULTIPLE)*7)))
   return{rank:0,symbol:item.underlying_symbol!.toUpperCase(),name:item.name||item.trading_symbol||item.underlying_symbol!,sector:'F&O',score,bias:f.direction,change:Number(quote.net_change??0),volume:(quote.volume??0).toLocaleString('en-IN'),rs:'Neutral',setup:`EXT VOL ${f.vr.toFixed(2)}× + ${f.pdBreak} BREAK${f.forming?' • LIVE 5M':''}`,confidence:score>=90?'A+':score>=80?'A':score>=70?'B+':'B',lastPrice:quote.last_price,oi:quote.oi??null,rvol:+f.vr.toFixed(2),rangePct:0,nr4:false,nr7:false,pdBreak:f.pdBreak,t1Date:today,filterPass:true,filterLabel:'LIVE NSE F&O + 5M PDH/PDL breakout + extreme volume ≥2.5× previous 20 completed 5M candles',filterDate:today,signalTime:f.candleTime,marketDirection:'NEUTRAL',marketAligned:true,openingRangeBreak:false,extremeVolume:true,forming:f.forming}
  }catch{intradayErrors++;return null}})
  const candidates=rows.filter(Boolean).sort((a:any,b:any)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()||b.score-a.score).slice(0,TOP).map((x:any,i)=>({...x,rank:i+1}))

  const indexQueries=[['NIFTY 50','NIFTY 50'],['BANKNIFTY','BANK NIFTY'],['NIFTY MIDCAP 100','NIFTY MIDCAP'],['INDIA VIX','INDIA VIX']]
  const indexes=await Promise.all(indexQueries.map(async([query,label])=>{try{const u=new URL(`${V2}/instruments/search`);u.searchParams.set('query',query);u.searchParams.set('exchanges','NSE');u.searchParams.set('segments','INDEX');u.searchParams.set('records','10');const found=((await api(u.toString(),token,'Index search')).data??[] as I[]).find(x=>x.trading_symbol?.toUpperCase()===query.toUpperCase()||x.name?.toUpperCase()===query.toUpperCase());if(!found)return{title:label,value:null,change:null};const q=(await quotes([found.instrument_key],token))[key(found.instrument_key)];return{title:label,value:q?.last_price??null,change:q?.last_price&&q?.net_change!=null?q.net_change/(q.last_price-q.net_change)*100:null}}catch{return{title:label,value:null,change:null}}}))
  const niftyChange=Number(indexes[0]?.change??0),marketDirection=niftyChange>0.15?'LONG':niftyChange<-0.15?'SHORT':'NEUTRAL'
  return NextResponse.json({ok:true,source:'UPSTOX LIVE + TODAY HIGH/LOW PDH/PDL PREFILTER + 5M EXTREME-VOLUME ENGINE',timestamp:new Date().toISOString(),universeCount:stocks.length,scanned:universe.length,expiry:near,diagnostics:{intradaySuccess,intradayErrors,triggerCount,scanPool:scanPool.length,candidates:candidates.length,liveFallbackChecks,liveFallbackHits,pdhSourceCounts:{UPSTOX_PREV_OHLC:scanPool.length,HISTORICAL_5M:0,FAILED:universe.length-scanPool.length},preFilter:`Today's HIGH > PDH or today's LOW < PDL reduced ${universe.length} stocks to ${scanPool.length} before 5M requests`,marketHours:true,marketDirection,niftyChange},filter:{universe:'NSE F&O stock futures — current near-expiry underlyings',fiveMinuteVolume:'5m candle volume ≥ 2.5 × previous 20 completed 5m candles — mandatory',breakout:'A TODAY 5M candle must close above PDH for LONG or below PDL for SHORT — mandatory. The daily pre-filter uses today high/low so earlier breakouts are not missed.',live:'Current forming 5m candle is checked from 1m data when no completed 5m signal exists'},indexes,candidates})
 }catch(e:any){return NextResponse.json({ok:false,error:e?.message||'Market scan failed'},{status:500})}
}
