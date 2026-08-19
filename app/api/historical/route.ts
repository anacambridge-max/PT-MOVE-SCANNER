// Vercel deployment marker: live 09:15-session scanner build.
import { NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'

export const maxDuration=60

const V2='https://api.upstox.com/v2',V3='https://api.upstox.com/v3'
const MASTER='https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
const MAX_SCAN=500,CONCURRENCY=12,TOP=30,CACHE_MS=120000

type I={instrument_key:string;trading_symbol?:string;name?:string;segment?:string;instrument_type?:string;underlying_symbol?:string;underlying_key?:string;underlying_type?:string;expiry?:number|string}
type C=[string,number,number,number,number,number,number]
type D={date:string;open:number;high:number;low:number;close:number;volume:number}
type Result={rank:number;symbol:string;name:string;sector:string;score:number;moveQuality:number;bias:'LONG'|'SHORT';change:number;volume:string;rs:string;setup:string;confidence:string;lastPrice:number;oi:null;rvol:number;rangePct:number;nr4:boolean;nr7:boolean;pdBreak:string;t1Date:string;filterPass:boolean;filterLabel:string;filterDate:string;signalTime:string;marketDirection:string;marketAligned:boolean;openingRangeBreak:boolean;extremeVolume:boolean;hourlyCompression:boolean;hourlyTrend:boolean;weeklyRoom:number;monthlyRoom:number;dailyLocation:string}

const g=globalThis as typeof globalThis & {__ptHistoricalCache?:{at:number;data:unknown}}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function date(offset=0){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const y=+p.find(x=>x.type==='year')!.value,m=+p.find(x=>x.type==='month')!.value,d=+p.find(x=>x.type==='day')!.value;return new Date(Date.UTC(y,m-1,d+offset)).toISOString().slice(0,10)}
function expiry(x?:number|string){if(typeof x==='string'){if(/^\d{4}-\d{2}-\d{2}$/.test(x))return x;const t=Date.parse(x);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):''}if(typeof x==='number'&&Number.isFinite(x))return new Date(x<1e12?x*1000:x).toISOString().slice(0,10);return ''}
function dayOf(c:C){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c[0]))}
function daily(cs:C[]):D[]{const m=new Map<string,D>();for(const c of cs){const d=dayOf(c),x=m.get(d),o=+c[1],h=+c[2],l=+c[3],cl=+c[4],v=+c[5]||0;if(!x)m.set(d,{date:d,open:o,high:h,low:l,close:cl,volume:v});else{x.high=Math.max(x.high,h);x.low=Math.min(x.low,l);x.close=cl;x.volume+=v}}return Array.from(m.values()).sort((a,b)=>a.date.localeCompare(b.date))}