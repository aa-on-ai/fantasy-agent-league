import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {withOwnedBrowser,OWNED_BROWSER_PROFILE,dismissOwnedOptionalPrompt} from '../dist/src/platforms/yahoo/owned-browser.js';
import {captureOwnedObservation,validateOwnedObservation} from '../dist/src/platforms/yahoo/owned-sources.js';
import {FileLedger} from '../dist/src/execution/file-ledger.js';
import {readStop} from '../dist/src/runtime/native-read-proof.js';

const root=resolve(new URL('..',import.meta.url).pathname);
const binding={leagueId:'1659459',teamId:'1',teamName:'Stiff Arm ae',profileId:'fantasy-agent-1-owned-chrome',period:'2',season:2026,maxAgeMs:900000};
const origin='https://football.fantasysports.yahoo.com',team=origin+'/f1/1659459/1';
const dir=join(root,'runtime/private/owned-acquisition-inspections',new Date().toISOString().replaceAll(':','-'));
await mkdir(dir,{recursive:true,mode:0o700});
const checkpoint=async()=>{if(await readStop(join(root,'runtime/private/emergency-stop'))!=='clear')throw Error('emergency_stop');};
const ledger=new FileLedger(join(root,'runtime/private/browser-ledger'));
await ledger.exclusive('yahoo-owned-browser:'+binding.profileId,()=>withOwnedBrowser({profilePath:OWNED_BROWSER_PROFILE},async page=>{
  // Inspection cannot submit a Yahoo mutation, including through a form handler.
  await page.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.origin===origin&&!['GET','HEAD'].includes(r.method()))return route.abort();
    return route.fallback();
  });
  const capture=async(label,url)=>{
    await checkpoint();
    const u=new URL(url);
    if(u.origin!==origin||!(u.pathname==='/f1/1659459'||u.pathname.startsWith('/f1/1659459/')))throw Error('wrong_inspection_scope');
    await page.goto(url,{waitUntil:'load',timeout:20000});
    await dismissOwnedOptionalPrompt(page);
    const o=await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(o,binding);
    await writeFile(join(dir,label+'.json'),JSON.stringify(o)+'\n',{flag:'wx',mode:0o600});
    await page.screenshot({path:join(dir,label+'.png'),fullPage:true});
    console.log(JSON.stringify({label,url:o.url,capturedAt:o.capturedAt,headings:o.dom.headings,rows:o.dom.tables.map(t=>({headers:t.headers,count:t.rows.length})),queueText:o.dom.text.split('\n').filter(s=>/pending|waiver|claim|No players|All game times/i.test(s)),controls:o.dom.controls.filter(c=>c.tag==='select').map(c=>({name:c.name,value:c.value,options:c.options}))}));
    return o;
  };
  const roster=await capture('roster',team);
  for(const [label,path] of [['rules','/settings'],['pool','/players']]){
    const links=roster.dom.links.filter(l=>new URL(l.href).origin===origin&&new URL(l.href).pathname==='/f1/1659459'+path&&(label!=='pool'||l.text.trim()==='Players'));
    const urls=[...new Set(links.map(l=>l.href))];if(urls.length!==1)throw Error('ambiguous_observed_'+label+'_link');
    const o=await capture(label,urls[0]);
    if(label==='pool'){
      const select=name=>o.dom.controls.find(c=>c.tag==='select'&&c.name===name);
      const form=o.dom.forms.find(f=>f.method==='get'&&new URL(f.action).pathname==='/f1/1659459/players'&&f.controls.some(c=>c.name==='status'));
      if(!form||!select('status')?.options.some(v=>v.value==='FA')||!select('stat1')?.options.some(v=>v.value==='S_PW_2'))throw Error('free_agent_filter_unobserved');
      const positions=form.controls.filter(c=>c.name==='pos'&&c.type==='radio'&&!c.disabled).map(c=>c.value);
      for(const pos of ['O','K','DEF']){
        if(!positions.includes(pos))throw Error('position_filter_unobserved');
        const u=new URL(form.action);u.searchParams.set('status','FA');u.searchParams.set('stat1','S_PW_2');u.searchParams.set('pos',pos);
        await capture('free-agents-'+pos,u.href);
      }
    }
  }
}));
console.log(JSON.stringify({status:'inspected_no_submission',dir}));
