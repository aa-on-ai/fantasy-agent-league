import {mkdir,readFile,writeFile,unlink,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withOwnedBrowser,OWNED_BROWSER_PROFILE} from '../dist/src/platforms/yahoo/owned-browser.js';
import {collectOwnedLineup} from '../dist/src/platforms/yahoo/owned-collector.js';
import {runOwnedSeasonTask} from '../dist/src/runtime/owned-season-task.js';
import {createOpenClawManagerDecide} from '../dist/src/runtime/openclaw-manager.js';
import {FileLedger} from '../dist/src/execution/file-ledger.js';
import {digest} from '../dist/src/manager/season.js';
import {readStop} from '../dist/src/runtime/native-read-proof.js';

// This host deliberately has no production-write switch or executable transport.
// The scheduler supplies an immutable bounded occurrence, not a model-written packet.
const root=await realpath(resolve(new URL('..',import.meta.url).pathname));
const privateDirectory=join(root,'runtime/private');
const [mode,specFile]=process.argv.slice(2);
if(!['review','stop-proof'].includes(mode)||!specFile)throw Error('explicit_review_spec_required');
const specPath=await realpath(resolve(specFile));
if(!specPath.startsWith(join(privateDirectory,'owned-schedule-specs')+'/'))throw Error('unowned_review_spec');
const spec=JSON.parse(await readFile(specPath,'utf8'));
if(spec.schemaVersion!==1||spec.mode!=='review'||spec.event?.phase!=='lineup'||
   !/^[a-f0-9]{40}$/.test(spec.releaseSha??'')||spec.leagueId!=='425299'||spec.teamId!=='11'||
   !Number.isFinite(Date.parse(spec.event.opensAt))||!Number.isFinite(Date.parse(spec.event.closesAt))||
   Date.parse(spec.event.closesAt)-Date.parse(spec.event.opensAt)>15*60000)throw Error('invalid_review_spec');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git(['rev-parse','HEAD'])!==spec.releaseSha||git(['diff','HEAD','--','src','scripts','agents','package.json','package-lock.json','tsconfig.json'])||
   git(['ls-files','--others','--exclude-standard','--','src','scripts','agents']))throw Error('review_release_not_pinned');
const emergencyStopPath=join(privateDirectory,'emergency-stop');
const directory=join(privateDirectory,'owned-cold-reviews',digest(spec.event));
await mkdir(directory,{recursive:true,mode:0o700});
const probeStopPath=join(directory,'probe-stop');
const binding={leagueId:'425299',teamId:'11',teamName:'Artificial Grass Intelligence',profileId:'fantasy-agent-1-owned-chrome',season:2026,period:'2',maxAgeMs:900000};
const record=async o=>writeFile(join(directory,o.observationId+'.json'),JSON.stringify(o)+'\n',{flag:'wx',mode:0o600});
const counts={collections:0,decisions:0,submissions:0};
const cannotExecute=async()=>{throw Error('review_host_has_no_executor');};
const decide=createOpenClawManagerDecide({directory:join(privateDirectory,'openclaw-manager-runs'),emergencyStopPath});
const options={event:spec.event,repositoryRoot:root,privateDirectory,binding,mode:'review',
  additionalStopPaths:mode==='stop-proof'?[probeStopPath]:[],
  collect:async checkpoint=>{
    counts.collections++;
    return withOwnedBrowser({profilePath:OWNED_BROWSER_PROFILE},async page=>{
      // Block Yahoo state-changing requests even if a future collector regresses.
      await page.route('**/*',route=>{
        const r=route.request();
        if(new URL(r.url()).origin==='https://football.fantasysports.yahoo.com'&&!['GET','HEAD'].includes(r.method()))return route.abort();
        return route.fallback();
      });
      const assessment=await collectOwnedLineup(page,binding,record,checkpoint);
      await writeFile(join(directory,'assessment.json'),JSON.stringify(assessment)+'\n',{flag:'wx',mode:0o600});
      return assessment;
    });
  },
  decide:async request=>{counts.decisions++;return decide(request);},
  execution:{profileId:binding.profileId,emergencyStopPath,approval:null,pendingClaimsPageUrl:null,
    browserLedger:new FileLedger(join(privateDirectory,'browser-ledger')),
    execution:{leagueId:binding.leagueId,teamId:binding.teamId,maxAgeMs:binding.maxAgeMs,writesEnabled:false,
      releaseSha:spec.releaseSha,runningSha:spec.releaseSha,verifiedCapabilities:[],
      policy:{tradesEnabled:false,allowedActions:['set_lineup'],windows:[{kind:'set_lineup',opensAt:spec.event.opensAt,closesAt:spec.event.closesAt}]}}},
  transport:{read:cannotExecute,prepare:cannotExecute,commit:async()=>{counts.submissions++;return cannotExecute();},readback:cannotExecute},
  ledger:new FileLedger(join(privateDirectory,'action-ledger'))};
let marker;
try{
  if(mode==='stop-proof'){
    if(await readStop(emergencyStopPath)!=='clear')throw Error('operator_stop_already_present');
    const candidate=JSON.stringify({kind:'owned-scheduled-stop-proof',eventId:spec.event.id,token:randomUUID()})+'\n';
    await writeFile(probeStopPath,candidate,{flag:'wx',mode:0o600,flush:true});
    marker=candidate;
  }
  const receipt=await runOwnedSeasonTask(options);
  if(mode==='stop-proof'&&(receipt.code!=='emergency_stop'||receipt.duplicate||counts.collections||counts.decisions||counts.submissions))throw Error('stop_proof_failed');
  const summary={schemaVersion:1,mode,releaseSha:spec.releaseSha,receipt,counts,directory};
  await writeFile(join(directory,'result.json'),JSON.stringify(summary)+'\n',{flag:'wx',mode:0o600,flush:true});
  console.log(JSON.stringify(summary));
  if(mode==='review'&&receipt.status!=='reviewed')process.exitCode=2;
}finally{
  // This unique proof artifact is never the operator's canonical stop path.
  if(marker){
    if(await readFile(probeStopPath,'utf8')!==marker)throw Error('proof_stop_changed');
    await unlink(probeStopPath);
    await writeFile(join(directory,'stop-restored.json'),JSON.stringify({eventId:spec.event.id,restoredAt:new Date().toISOString(),probeRemoved:true,canonicalStopState:await readStop(emergencyStopPath),canonicalStopTouched:false})+'\n',{flag:'wx',mode:0o600,flush:true});
  }
}
