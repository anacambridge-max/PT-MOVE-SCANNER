import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const CONCURRENCY=6,TOP=30
const EXTREME_RVOL=2.50
const MASTER_LOOKBACK=5
const MASTER_MULTIPLIER=1.50
const SIGNAL_START=9*60+15
const SIGNAL_END=9*60+55

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type Q={instrument_token:string;symbol:string;last_price:number;volume?:number;net_change?:number;oi?:number}
type C=[string,number,number,number,number,number,number]
type O={prev_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number};live_ohlc?:{open:number;high:number;low:number;close:number;volume:number;ts:number}}

function key(x?:string|null){return x?.trim().replace('|',':')??''}
function date(offset=0){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date())
  const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value
  return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)
}
function istParts(ts:string|number){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(typeof ts==='number'?ts:ts))
  return {date:p.find(x=>x.type==='year')!.value+'-'+p.find(x=>x.type==='month')!.value+'-'+p.find(x=>x.type==='day')!.value,hour:+p.find(x=>x.type==='hour')!.value,minute:+p.find(x=>x.type==='minute')!.value}
}
function minuteOf(ts:string|number){const p=istParts(ts);return p.hour*60+p.minute}
function dayOf(c:C){return istParts(c[0]).date}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function expiry(x?:number|string){
  if(typeof x==='string'){const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}
  if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10)
  return ''
}
function completed(c:C[]){return c.filter(x=>new Date(x[0]).getTime()+5*60*1000<=Date.now()).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())}
function unique<T>(a:T[]){return [...new Set(a)]}

async function api(url:string,t:string,label:string){
  let last=0
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(url,{headers:{Accept:'application/json',Authorization:`Bearer ${t}`},cache:'no-store'})
    if(r.ok)return await r.json()
    last=r.status
    if(r.status!==429)throw Error(`${label} failed: ${r.status}`)
    await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)))
  }
  throw Error(`${label} failed: ${last}`)
}
async function instrumentMaster(){
  const r=await fetch(MASTER,{cache:'no-store'})
  if(!r.ok)throw Error(`Instrument master failed: ${r.status}`)
  const b=Buffer.from(await r.arrayBuffer());let s=''
  try{s=gunzipSync(b).toString()}catch{s=b.toString()}
  return JSON.parse(s) as I[]
}
async function quotes(keys:string[],t:string){
  const out:Record<string,Q>={}
  for(let i=0;i<keys.length;i+=400){
    const u=new URL(`${V2}/market-quote/quotes`)
    u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','))
    const d=(await api(u.toString(),t,'Quotes')).data??{}
    for(const [k,q] of Object.entries(d) as [string,Q][])out[key(k)]=q,out[key(q.instrument_token)]=q
  }
  return out
}
async function dailyOHLC(keys:string[],t:string){
  const out:Record<string,O>={}
  for(let i=0;i<keys.length;i+=400){
    const u=new URL(`${V3}/market-quote/ohlc`)
    u.searchParams.set('instrument_key',keys.slice(i,i+400).join(','))
    u.searchParams.set('interval','1d')
    const d=(await api(u.toString(),t,'Daily OHLC')).data??{}
    for(const [k,q] of Object.entries(d) as [string,O][])out[key(k)]=q
  }
  return out
}
async function historical(k:string,t:string,unit:'minutes'|'weeks'|'months',interval:number,to:string,from?:string){
  const path=from?`${V3}/historical-candle/${encodeURIComponent(k)}/${unit}/${interval}/${to}/${from}`:`${V3}/historical-candle/${encodeURIComponent(k)}/${unit}/${interval}/${to}`
  const d=await api(path,t,`${unit}/${interval} history`)
  return(d.data?.candles??[]) as C[]
}
async function fiveMin(k:string,t:string){
  const d=await api(`${V3}/historical-candle/intraday/${encodeURIComponent(k)}/minutes/5`,t,'5M intraday')
  return(d.data?.candles??[]) as C[]
}
async function mapLimit<T,R>(a:T[],n:number,fn:(x:T)=>Promise<R>){
  const out:R[]=new Array(a.length);let i=0
  async function worker(){while(true){const j=i++;if(j>=a.length)return;out[j]=await fn(a[j])}}
  await Promise.all(Array.from({length:Math.min(n,a.length)},worker));return out
}

function levelsFromHistory(weeks:C[],months:C[],today:string){
  const ws=[...weeks].sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())
  const ms=[...months].sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())
  const currentWeek=ws.at(-1),currentMonth=ms.at(-1)
  const prevWeek=ws.length>1?ws[ws.length-2]:undefined
  const prevMonth=ms.length>1?ms[ms.length-2]:undefined
  const completedWeeks=ws.filter(c=>dayOf(c)<today)
  const prior52=completedWeeks.slice(Math.max(0,completedWeeks.length-52))
  // Weekly highs/lows preserve the all-time extrema while avoiding a multi-call daily history sweep.
  const ath=completedWeeks.length?Math.max(...completedWeeks.map(c=>+c[2])):NaN
  const atl=completedWeeks.length?Math.min(...completedWeeks.map(c=>+c[3])):NaN
  return {
    weeklyHigh:prevWeek?.[2],weeklyLow:prevWeek?.[3],
    monthlyHigh:prevMonth?.[2],monthlyLow:prevMonth?.[3],
    yearHigh:prior52.length?Math.max(...prior52.map(c=>+c[2])):NaN,
    yearLow:prior52.length?Math.min(...prior52.map(c=>+c[3])):NaN,
    ath,atl,currentWeekDate:currentWeek?dayOf(currentWeek):'',currentMonthDate:currentMonth?dayOf(currentMonth):''
  }
}
function levelName(buy:boolean,flags:{pdh:boolean;weekly:boolean;monthly:boolean;year:boolean;ath:boolean}){
  if(buy)return flags.ath?'ATH':flags.year?'52W HIGH':flags.monthly?'MONTHLY HIGH':flags.weekly?'WEEKLY HIGH':flags.pdh?'PDH':'NONE'
  return flags.ath?'ATL':flags.year?'52W LOW':flags.monthly?'MONTHLY LOW':flags.weekly?'WEEKLY LOW':flags.pdh?'PDL':'NONE'
}
function scanOne(sessionRaw:C[],historyRaw:C[],pdh:number,pdl:number,levels:any,quote:Q,today:string){
  const session=completed(sessionRaw).filter(c=>dayOf(c)===today).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())
  if(!session.length)return null
  const history=completed(historyRaw).filter(c=>dayOf(c)<today).sort((a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime())
  const all=[...history,...session]
  const prior0915=history.filter(c=>minuteOf(c[0])===SIGNAL_START).slice(-20)
  const openingBase=avg(prior0915.map(c=>+c[5]||0))
  let best:any=null
  for(const c of session){
    const m=minuteOf(c[0])
    if(m<SIGNAL_START||m>SIGNAL_END)continue
    const idx=all.findIndex(x=>x[0]===c[0])
    const prev5=idx>0?all.slice(Math.max(0,idx-MASTER_LOOKBACK),idx):[]
    const range=+c[2]-+c[3]
    const priorRangeAvg=avg(prev5.map(x=>+x[2]-+x[3]))
    // Pine ta.sma(volume,20) includes the current bar; reproduce that behavior here.
    const normalVolBase=avg(all.slice(Math.max(0,idx-19),idx+1).map(x=>+x[5]||0))
    const normalRVOL=normalVolBase>0?(+c[5]||0)/normalVolBase:0
    const effectiveRVOL=m===SIGNAL_START&&openingBase>0?(+c[5]||0)/openingBase:normalRVOL
    const extreme=effectiveRVOL>=EXTREME_RVOL
    const master=priorRangeAvg>0&&range>=priorRangeAvg*MASTER_MULTIPLIER&&extreme
    const bullish=+c[4]>+c[1],bearish=+c[4]<+c[1]
    const buyFlags={
      pdh:Number.isFinite(pdh)&&+c[2]>=pdh,
      weekly:Number.isFinite(levels.weeklyHigh)&&+c[2]>=levels.weeklyHigh,
      monthly:Number.isFinite(levels.monthlyHigh)&&+c[2]>=levels.monthlyHigh,
      year:Number.isFinite(levels.yearHigh)&&+c[2]>=levels.yearHigh,
      ath:Number.isFinite(levels.ath)&&+c[2]>=levels.ath
    }
    const sellFlags={
      pdh:Number.isFinite(pdl)&&+c[3]<=pdl,
      weekly:Number.isFinite(levels.weeklyLow)&&+c[3]<=levels.weeklyLow,
      monthly:Number.isFinite(levels.monthlyLow)&&+c[3]<=levels.monthlyLow,
      year:Number.isFinite(levels.yearLow)&&+c[3]<=levels.yearLow,
      ath:Number.isFinite(levels.atl)&&+c[3]<=levels.atl
    }
    const anyBuy=Object.values(buyFlags).some(Boolean),anySell=Object.values(sellFlags).some(Boolean)
    const openingBuy=m===SIGNAL_START&&extreme&&bullish&&anyBuy
    const openingSell=m===SIGNAL_START&&extreme&&bearish&&anySell
    const masterBuy=master&&bullish&&anyBuy
    const masterSell=master&&bearish&&anySell
    if(!openingBuy&&!openingSell&&!masterBuy&&!masterSell)continue
    const isBuy=openingBuy||masterBuy
    const flags=isBuy?buyFlags:sellFlags
    const score=isBuy?(buyFlags.ath?100:buyFlags.year?80:buyFlags.monthly?60:buyFlags.weekly?40:buyFlags.pdh?20:0):(sellFlags.ath?100:sellFlags.year?80:sellFlags.monthly?60:sellFlags.weekly?40:sellFlags.pdh?20:0)
    const trigger=openingBuy||openingSell?'09:15 OPENING':'MASTER CANDLE'
    best={
      vr:+effectiveRVOL.toFixed(2),direction:isBuy?'LONG':'SHORT',pdBreak:levelName(isBuy,flags),candleTime:c[0],trigger,master,opening:m===SIGNAL_START,score,bullish,bearish,
      rangePct:quote.last_price>0?((+c[2]-+c[3])/quote.last_price)*100:0,candleRange:range,priorRangeAvg,
      levels:{pdh,pdl,weeklyHigh:levels.weeklyHigh,weeklyLow:levels.weeklyLow,monthlyHigh:levels.monthlyHigh,monthlyLow:levels.monthlyLow,yearHigh:levels.yearHigh,yearLow:levels.yearLow,ath:levels.ath,atl:levels.atl}
    }
  }
  return best
}

export async function GET(){
  const token=process.env.UPSTOX_ANALYTICS_TOKEN
  if(!token)return NextResponse.json({ok:false,error:'UPSTOX_ANALYTICS_TOKEN is not configured'},{status:500})
  try{
    const all=await instrumentMaster(),today=date()
    const futures=all.filter(x=>x.segment==='NSE_FO'&&x.instrument_type==='FUT'&&x.underlying_type==='EQUITY'&&x.underlying_key&&x.underlying_symbol&&expiry(x.expiry)>=today)
    const near=unique(futures.map(x=>expiry(x.expiry)).filter(Boolean)).sort()[0]
    const m=new Map<string,I>();for(const x of futures.filter(x=>expiry(x.expiry)===near))m.set(x.underlying_symbol!.toUpperCase(),x)
    const stocks=[...m.values()]
    if(!stocks.length)throw Error('NSE F&O universe is empty')

    const stockKeys=stocks.map(x=>x.underlying_key!),[qs,oh]=await Promise.all([quotes(stockKeys,token),dailyOHLC(stockKeys,token)])
    const universe=stocks.map(item=>({item,key:key(item.underlying_key),quote:qs[key(item.underlying_key)],ohlc:oh[key(item.underlying_key)]})).filter(x=>x.quote?.last_price>0)

    const rows=await mapLimit(universe,CONCURRENCY,async({item,key,quote,ohlc})=>{
      try{
        const pdh=ohlc?.prev_ohlc?.high??NaN,pdl=ohlc?.prev_ohlc?.low??NaN
        const [session,history,weekly,monthly]=await Promise.all([
          fiveMin(key,token),
          historical(key,token,'minutes',5,date(-1),date(-30)),
          historical(key,token,'weeks',1,today,'2000-01-01'),
          historical(key,token,'months',1,today,'2000-01-01')
        ])
        const baseLevels=levelsFromHistory(weekly,monthly,today)
        const f=scanOne(session,history,pdh,pdl,baseLevels,quote,today)
        if(!f)return null
        const score=f.score
        return{
          rank:0,symbol:item.underlying_symbol!.toUpperCase(),name:item.name||item.trading_symbol||item.underlying_symbol!,sector:'F&O',score,bias:f.direction,change:Number(quote.net_change??0),volume:(quote.volume??0).toLocaleString('en-IN'),rs:'Neutral',
          setup:`${f.trigger} + EXT VOL ${f.vr.toFixed(2)}× + ${f.pdBreak} ${f.direction==='LONG'?'BREAKOUT':'BREAKDOWN'}`,
          confidence:score>=90?'A+':score>=80?'A':score>=70?'B+':'B',lastPrice:quote.last_price,oi:quote.oi??null,rvol:f.vr,rangePct:+f.rangePct.toFixed(2),nr4:false,nr7:false,pdBreak:f.pdBreak,t1Date:today,
          filterPass:true,filterLabel:'PRIME TECHNICAL L-1 • 5M • 09:15–09:55 • EXTREME RVOL ≥2.50 • OPENING/MASTER + MAJOR LEVEL',filterDate:today,signalTime:f.candleTime,marketDirection:'NEUTRAL',marketAligned:true,openingRangeBreak:false,extremeVolume:true,forming:false,
          trigger:f.trigger,masterCandle:f.master,openingCandle:f.opening,majorLevel:f.pdBreak,signalScore:score,levels:f.levels,
          conditions:{timeframe:'5M',signalWindow:'09:15–09:55',confirmed:true,extremeVolume:true,rvol:f.vr,rvolThreshold:EXTREME_RVOL,masterCandle:f.master,masterRangeMultiplier:MASTER_MULTIPLIER,majorLevelCross:true,trigger:f.trigger}
        }
      }catch{return null}
    })
    const candidates=rows.filter(Boolean).sort((a:any,b:any)=>new Date(b.signalTime).getTime()-new Date(a.signalTime).getTime()||b.score-a.score).slice(0,TOP).map((x:any,i)=>({...x,rank:i+1}))

    const indexQueries=[['NIFTY 50','NIFTY 50'],['BANKNIFTY','BANK NIFTY'],['NIFTY MIDCAP 100','NIFTY MIDCAP'],['INDIA VIX','INDIA VIX']]
    const indexes=await Promise.all(indexQueries.map(async([query,label])=>{
      try{
        const u=new URL(`${V2}/instruments/search`);u.searchParams.set('query',query);u.searchParams.set('exchanges','NSE');u.searchParams.set('segments','INDEX');u.searchParams.set('records','10')
        const found=((await api(u.toString(),token,'Index search')).data??[] as I[]).find(x=>x.trading_symbol?.toUpperCase()===query.toUpperCase()||x.name?.toUpperCase()===query.toUpperCase())
        if(!found)return{title:label,value:null,change:null}
        const q=(await quotes([found.instrument_key],token))[key(found.instrument_key)]
        return{title:label,value:q?.last_price??null,change:q?.last_price&&q?.net_change!=null?q.net_change/(q.last_price-q.net_change)*100:null}
      }catch{return{title:label,value:null,change:null}}
    }))
    const niftyChange=Number(indexes[0]?.change??0),marketDirection=niftyChange>0.15?'LONG':niftyChange<-0.15?'SHORT':'NEUTRAL'
    return NextResponse.json({
      ok:true,source:'UPSTOX LIVE + PRIME TECHNICAL L-1 EXACT FILTER',timestamp:new Date().toISOString(),universeCount:stocks.length,scanned:universe.length,expiry:near,
      diagnostics:{candidates:candidates.length,scanWindow:'09:15–09:55 IST',noNewSignalAfter:'10:00 IST',confirmedOnly:true,extremeRVOL:EXTREME_RVOL,masterMultiplier:MASTER_MULTIPLIER,historicalBaseline:'20 previous 09:15 candles for opening RVOL; 20-candle normal RVOL otherwise',marketDirection,niftyChange},
      filter:{universe:'NSE F&O stock futures — current near-expiry underlyings',timeframe:'5M only',signalWindow:'09:15–09:55 IST only',confirmed:'Only completed/confirmed 5M candles',opening:'09:15 candle + extreme volume + bullish/bearish + major high/low cross; no master candle required',master:'09:15–09:55 candle + range >= 1.50× previous 5-candle average range + extreme volume + bullish/bearish + major high/low cross',extremeVolume:'RVOL >= 2.50; 09:15 uses average of previous 20 sessions 09:15 volume, other candles use 20-candle normal RVOL',levels:'PDH/PDL + previous weekly high/low + previous monthly high/low + 52-week high/low + ATH/ATL',cross:'BUY when candle HIGH >= level; SELL when candle LOW <= level',noNewSignalAfter:'10:00 IST'},
      indexes,candidates
    })
  }catch(e:any){return NextResponse.json({ok:false,error:e?.message||'Market scan failed'},{status:500})}
}
