import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {withOwnedBrowser,OWNED_BROWSER_PROFILE,dismissOwnedOptionalPrompt} from '../dist/src/platforms/yahoo/owned-browser.js';
import {captureOwnedObservation,validateOwnedObservation} from '../dist/src/platforms/yahoo/owned-sources.js';
import {FileLedger} from '../dist/src/execution/file-ledger.js';
import {readStop} from '../dist/src/runtime/native-read-proof.js';
const root=resolve(new URL('..',import.meta.url).pathname),base=join(root,'runtime/private');
const binding={leagueId:'1659459',teamId:'1',teamName:'Stiff Arm ae',profileId:'fantasy-agent-1-owned-chrome',season:2026,period:'2',maxAgeMs:900000};
const dir=join(base,'owned-claims-inspections',new Date().toISOString().replaceAll(':','-'));
await mkdir(dir,{recursive:true,mode:0o700});
await new FileLedger(join(base,'browser-ledger')).exclusive('yahoo-owned-browser:'+binding.profileId,()=>withOwnedBrowser({profilePath:OWNED_BROWSER_PROFILE},async page=>{
 if(await readStop(join(base,'emergency-stop'))!=='clear')throw Error('emergency_stop');
 await page.route('**/*',route=>{
  const r=route.request();if(new URL(r.url()).origin==='https://football.fantasysports.yahoo.com'&&!['GET','HEAD'].includes(r.method()))return route.abort();return route.fallback();
 });
 await page.goto('https://football.fantasysports.yahoo.com/f1/1659459/1',{waitUntil:'load',timeout:20000});
 await dismissOwnedOptionalPrompt(page);
 const observation=await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(observation,binding);
 await writeFile(join(dir,'roster.json'),JSON.stringify(observation)+'\n',{flag:'wx',mode:0o600});
 await page.screenshot({path:join(dir,'roster.png'),fullPage:true});
 // Structural inventory only: never copy script bodies, hidden values, tokens or credentials.
 const structure=await page.evaluate(()=>({
  readyState:document.readyState,
  elements:[...document.querySelectorAll('[id],[class],a,button')].filter(e=>
    /waiv|pending|claim|transaction/i.test(e.id+' '+String(e.className)+' '+(e.getAttribute('href')??'')+' '+(e.childElementCount===0?e.textContent:'')))
    .filter(e=>!['SCRIPT','STYLE','INPUT'].includes(e.tagName)).map(e=>({tag:e.tagName,id:e.id,classes:String(e.className),visible:!!e.getClientRects().length,
      text:e.textContent?.trim().slice(0,500),href:e instanceof HTMLAnchorElement?new URL(e.href).pathname:null})),
  scripts:[...document.scripts].map((s,index)=>({index,source:s.src?new URL(s.src).origin+new URL(s.src).pathname:null,type:s.type,
    matchingKeys:[...s.textContent.matchAll(/["']([a-zA-Z_][a-zA-Z0-9_-]*(?:waiv|pending|claim|transaction)[a-zA-Z0-9_-]*)["']\s*:/gi)].map(m=>m[1]),
    keywordCounts:Object.fromEntries(['waiver','pending','claim','transaction'].map(k=>[k,(s.textContent.toLowerCase().match(new RegExp(k,'g'))??[]).length]))
  })).filter(s=>s.matchingKeys.length||Object.values(s.keywordCounts).some(Boolean)),
  runtimeNames:Object.getOwnPropertyNames(window).filter(k=>/yahoo|fantasy|root\.app/i.test(k)),
  waiverModule:[...document.scripts].filter(s=>s.textContent.includes('ysf-editwaivers')).map(s=>{
   const text=s.textContent,index=text.indexOf('ysf-editwaivers');
   const fragment=text.slice(Math.max(0,index-80),index+900);
   return /crumb|secret|token|authorization|cookie|api[_-]?key/i.test(fragment)?'omitted_sensitive_neighbor':fragment;
  }),
  yahooNames:window.YAHOO?Object.keys(window.YAHOO):[]
 }));
 await writeFile(join(dir,'structure.json'),JSON.stringify(structure)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({directory:dir,structure}));
}));
