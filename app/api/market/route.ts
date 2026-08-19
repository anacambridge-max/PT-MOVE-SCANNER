import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const MAX_SCAN=500,CONCURRENCY=8,TOP=30,EXTREME_MULTIPLE=2.5

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token:string;symbol:string;last_price:number;volume?:number;net_change?:number;oi?:number}
type C=[string,number,number,number,number,number,number]
type O={last_price?:number;instrument_token?:string;prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number};live_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}
const indexes=[['NIFTY 50','NIFTY 50'],['BANKNIFTY','BANK NIFTY'],['NIFTY MIDCAP 100','NIFTY MIDCAP'],['INDIA VIX','INDIA VIX']] as const
function key(x?:string|null){return x?.trim().replace('|',':')??''}
function date(offset=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)}
function istHour(){return Number(new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',hour12:false}).format(new Date()))}
function expiry(x?:number|string){if(typeof x==='string'){if(/^\d{4}-\d{2}-\d{2}$/.test(x))return x;const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function dayOf(c:C){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))}
async function upstoxJson(url:string,t:string,label:string){let last=0;for(let attempt=0;attempt<5;attempt++){const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${t}`},cache:'no-store'});if(r.ok)return await r.json();last=r.status;if(r.status!==429)throw Error(`${label} failed: ${r.status}`);const retry=Number(r.headers.get('retry-after')||0);const wait=retry>0?Math.min(retry*1000,5000):1000*(attempt+1);await new Promise(resolve=>setTimeout(resolve,wait))}throw Error(`${label} failed: ${last} after retries`)}
async function fno(){const r=await fetch(MASTER,{cache:'no-store'});if(!r.ok)throw Error(`Instrument master failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());let s='';try{s=gunzipSync(b).toString()}catch{s=b.toString()}const a=JSON.parse(s) as I[],today=date();const v=a.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today);const ex=Array.from(new Set(v.map(x=>expiry(x.expiry)).filter(Boolean))).sort()[0];const m=new Map<string,I>();for(const x of v.filter(x=>expiry(x.expiry)===ex))m.set(x.underlying_symbol!.toUpperCase(),x);return{stocks:Array.from(m.values()),expiry:ex??null,universeCount:m.size}}
async function search(q:string,t:string){const u=new URL(`${V2}/instruments/search`);u.searchParams.set('query',q);u.searchParams.set('exchanges','NSE');u.searchParams.set('segments','INDEX');u.searchParams.set('records','10');return((await upstoxJson(u.toString(),t,'Index search')).data??[] as I[]).find(x=>x.trading_symbol?.toUpperCase()===q.toUpperCase()||x.name?.toUpperCase()===q.toUpperCase())}
async function quotes(keys:string[],t:string){const out:Record<string,Q>={};for(let i=0;i<keys.length;i+=400){const u=new URL(`${V2}/market-quote/quotes`);u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','));const d=(await upstoxJson(u.toString(),t,'Quotes')).data??{};for(const [k,q] of Object.entries(d) as [string,Q][])out[key(k)]=q,out[key(q.instrument_token)]=q}return out}
async function dailyOhlc(keys:string[],t:string){const out:Record<string,O>={};for(let i=0;i<keys.length;i+=500){const u=new URL(`${V3}/market-quote/ohlc`);u.searchParams.set('instrument_key',keys.slice(i,i+500).join(','));u.searchParams.set('interval','1d');const d=(await upstoxJson(u.toString(),t,'Daily OHLC')).data??{};for(const [k,q] of Object.entries(d) as [string,O][])out[key(k)]=q,out[key(q.instrument_token)]=q}return out}
async function intraday5m(k:string,t:string){const d=await upstoxJson(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/5`,t,'Intraday 5m');return(d.data?.candles??[]) as C[]}
async function historical5m(k:string,t:string){const d=await upstoxJson(`${V3}/historical-candle/${encodeURIComponent(k)}/minutes/5/${date(-1)}/${date(-7)}`,t,'Previous 5m volume');return(d.data?.candles??[]) as C[]}
function completed(c:C[]){const now=Date.now();return c.filter(x=>new Date(x[0]).getTime()+5*60*1000<=now).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())}
function trigger(sessionRaw:C[],prev5m:C[],prevHigh:number,prevLow:number){
 const session=completed(sessionRaw);if(!session.length)return null
 const history=completed(prev5m).filter(c=>dayOf(c)<date())
 let best:any=null
 for(let i=0;i<session.length;i++){
  const c=session[i],v=+c[5]||0,prior=[...history,...session.slice(0,i)].slice(-20).map(x=>+x[5]||0),sma=avg(prior)
  if(prior.length<20||!sma||v/sma<EXTREME_MULTIPLE)continue
  const cl=+c[4],h=+c[2],lo=+c[3]
  const longBreak=cl>prevHigh&&h>prevHigh,shortBreak=cl<prevLow&&lo<prevLow
  if(!longBreak&&!shortBreak)continue
  best={vr:v/sma,direction:longBreak?'LONG':'SHORT',pdBreak:longBreak?'PDH':'PDL',candleTime:c[0],close:cl,high:h,low:lo}
 }
 return best
}
async function map<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){const out:R[]=new Array(a.length);let i=0;async function run(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}await Promise.all(Array.from({length:Math.min(n,a.length)},run));return out}

export async function GET(){
 const token=process.env.UPSTOX_ANALYTICS_TOKEN
 if(!token)return NextResponse.json({ok:false,error:'UPSTOX_ANALYTICS_TOKEN is not configured'},{status:500})
 try{
  const[{stocks,expiry:nearExpiry,universeCount},ix]=await Promise.all([fno(),Promise.all(indexes.map(async([q,label])=>({label,instrument:await search(q,token)})))])
  if(!stocks.length)throw Error('NSE F&O universe is empty')
  const stockKeys=stocks.map(x=>x.underlying_key!)
  const [qs,ohlcs]=await Promise.all([quotes(stockKeys.concat(ix.map(x=>x.instrument?.instrument_key).filter(Boolean) as string[]),token),dailyOhlc(stockKeys,token)])
  const nifty=ix.find(x=>x.label==='NIFTY 50')?.instrument?.instrument_key,nq=nifty?qs[key(nifty)]:undefined,niftyChange=Number(nq?.net_change??0)
  const marketHours=istHour()>=9&&istHour()<16,marketDirection=niftyChange>0.15?'LONG':niftyChange<-0.15?'SHORT':'NEUTRAL'
  const universe=stocks.map(item=>({item,key:key(item.underlying_key),quote:qs[key(item.underlying_key)],ohlc:ohlcs[key(item.underlying_key)]})).filter((x):x is {item:I;key:string;quote:Q;ohlc:O}=>Boolean(x.quote&&x.quote.last_price>0&&x.ohlc?.prev_ohlc&&x.ohlc.live_ohlc))
  const breakoutPool=universe.filter(x=>{const p=x.ohlc.prev_ohlc!,l=x.ohlc.live_ohlc!;return l.high>p.high||l.low<p.low})
  let intradaySuccess=0,intradayErrors=0,triggerCount=0
  const rows=await map(breakoutPool,CONCURRENCY,async({item,key,quote,ohlc})=>{
   try{
    const session=await intraday5m(key,token)
    const early=completed(session).length<20
    const prior=early?await historical5m(key,token):[]
    const p=ohlc.prev_ohlc!
    const f=trigger(session,prior,p.high,p.low)
    intradaySuccess++
    if(!f)return null
    triggerCount++
    const change=Number(quote.net_change??0),rsAligned=f.direction==='LONG'?change>niftyChange+0.25:change<niftyChange-0.25,marketAligned=marketDirection==='NEUTRAL'||f.direction===marketDirection
    const score=Math.min(99,Math.round(60+Math.min(25,(f.vr-EXTREME_MULTIPLE)*7)+(rsAligned?7:0)+(marketAligned?4:0)))
    return{rank:0,symbol:item.underlying_symbol!.toUpperCase(),name:item.name||item.trading_symbol||item.underlying_symbol!,sector:'F&O',score,bias:f.direction,change,volume:(quote.volume??0).toLocaleString('en-IN'),rs:rsAligned?'Strong':'Neutral',setup:`EXT VOL ${f.vr.toFixed(2)}× + ${f.pdBreak} BREAK`,confidence:score>=90?'A+':score>=80?'A':score>=70?'B+':'B',lastPrice:quote.last_price,oi:quote.oi??null,rvol:+f.vr.toFixed(2),rangePct:0,nr4:false,nr7:false,pdBreak:f.pdBreak,t1Date:date(),filterPass:true,filterLabel:'LIVE NSE F&O + completed 5M candle closing beyond PDH/PDL + extreme volume ≥2.5× previous 20 completed 5M candles',filterDate:date(),signalTime:f.candleTime,marketDirection,marketAligned,openingRangeBreak:false,extremeVolume:true}
   }catch{intradayErrors++;return null}
  })
  const candidates=rows.filter((x):x is NonNullable<typeof x>=>Boolean(x)).sort((a,b)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()||b.score-a.score).slice(0,TOP).map((x,i)=>({...x,rank:i+1}))
  const indexesOut=ix.map(x=>{const q=qs[key(x.instrument?.instrument_key)],last=q?.last_price??null,net=q?.net_change??null;return{title:x.label,value:last,change:last&&net!=null?net/(last-net)*100:null}})
  return NextResponse.json({ok:true,source:'UPSTOX LIVE + V3 5M PDH/PDL EXTREME-VOLUME ENGINE',timestamp:new Date().toISOString(),universeCount,scanned:universe.length,expiry:nearExpiry,diagnostics:{intradaySuccess,intradayErrors,triggerCount,breakoutPool:breakoutPool.length,candidates:candidates.length,marketHours,marketDirection,niftyChange},filter:{universe:'NSE F&O stock futures — all current near-expiry underlyings checked for today\'s PDH/PDL break',fiveMinuteVolume:'Completed 5m candle volume ≥ 2.5 × previous 20 completed 5m candles — mandatory',breakout:'Completed 5m candle CLOSE > previous-day HIGH (PDH) for LONG OR CLOSE < previous-day LOW (PDL) for SHORT — mandatory',candidateRule:'A stock appears only when BOTH PDH/PDL breakout and extreme 5m volume occur on the same completed candle',marketDirection:'NIFTY 50 direction is confirmation only; it does not block a valid PDH/PDL + extreme-volume signal',price:'No artificial price filter'},candidates,indexes:indexesOut})
 }catch(e){return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Market scan failed'},{status:500})}
}
