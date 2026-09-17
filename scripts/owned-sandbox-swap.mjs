import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {withOwnedBrowser,OWNED_BROWSER_PROFILE,YahooOwnedDriver} from '../dist/src/platforms/yahoo/owned-browser.js';
import {captureOwnedObservation,normalizeOwnedAssessment,validateOwnedObservation} from '../dist/src/platforms/yahoo/owned-sources.js';
import {runGuardedOwnedAction} from '../dist/src/platforms/yahoo/guarded-owned.js';
import {FileLedger} from '../dist/src/execution/file-ledger.js';
import {actionFingerprint} from '../dist/src/execution/coordinator.js';
import {readStop} from '../dist/src/runtime/native-read-proof.js';
const root=resolve(new URL('..',import.meta.url).pathname), privateRoot=join(root,'runtime/private');
const mode=process.argv[2];if(!['inspect','execute'].includes(mode))throw Error('explicit_mode_required');
const releaseSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(execFileSync('git',['diff','HEAD','--','src','scripts/owned-sandbox-swap.mjs'],{cwd:root,encoding:'utf8'}).trim())throw Error('acceptance_source_not_pinned');
const dir=join(privateRoot,'owned-sandbox-swap',new Date().toISOString().replaceAll(':','-'));await mkdir(dir,{recursive:true,mode:0o700});
const binding={leagueId:'1659459',teamId:'1',teamName:'Stiff Arm ae',profileId:'fantasy-agent-1-owned-chrome',season:2026,period:'2',maxAgeMs:900000};
const emergencyStopPath=join(privateRoot,'emergency-stop');
const record=async o=>writeFile(join(dir,o.observationId+'.json'),JSON.stringify(o)+'\n',{flag:'wx',mode:0o600});
const ledger=new FileLedger(join(privateRoot,'action-ledger')),browserLedger=new FileLedger(join(privateRoot,'browser-ledger'));
let actionStarted=false;
try{await browserLedger.exclusive(`yahoo-owned-browser:${binding.profileId}`,()=>withOwnedBrowser({profilePath:OWNED_BROWSER_PROFILE},async page=>{
 if(await readStop(emergencyStopPath)!=='clear')throw Error('emergency_stop');
 const origin='https://football.fantasysports.yahoo.com';
 await page.goto(origin+'/f1/1659459/1',{waitUntil:'load',timeout:15000});
 const first=await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(first,binding);await record(first);
 const settings=first.dom.links.find(l=>l.href===origin+'/f1/1659459/settings');if(!settings)throw Error('missing_settings_link');
 await page.goto(settings.href,{waitUntil:'load',timeout:15000});const rules=await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(rules,binding);await record(rules);
 const normalize=async observation=>{const assessment=normalizeOwnedAssessment({roster:observation,rules},binding,'lineup');if(!assessment.snapshot)throw Error('invalid_sandbox_snapshot:'+assessment.gaps.join(','));return {observation,snapshot:assessment.snapshot,lineupDeadlines:assessment.lineupDeadlines,acquisitionDeadlines:{},pendingClaims:null};};
 const driver=new YahooOwnedDriver(page,{binding,profileId:binding.profileId,emergencyStopPath,allowSubmission:mode==='execute',normalize,record,atomicSwapEvidence:'runtime/private/owned-manager-2026-09-15/sandbox-swap-selection-2026-09-15T22-39-20.354Z.json',atomicAcquisitionEvidence:null,swapSelection:{sourceClass:'swapactive',targetClass:'swaptarget'}});
 const state=await driver.read();
 const lineup=Object.fromEntries(state.snapshot.roster.filter(p=>p.slot).map(p=>[p.slot,p.id]));
 const target={...lineup,'QB:1':'29235'};
 const action={kind:'set_lineup',lineup:target,projectedPoints:Object.values(target).reduce((n,id)=>n+state.snapshot.roster.find(p=>p.id===id).projectedPoints,0)};
 const actionId=actionFingerprint(state.snapshot,action);
 const previous=await ledger.get(actionId);if(previous?.status==='verified'){console.log(JSON.stringify({status:'already_verified',actionId,dir}));return;}
 if(lineup['QB:1']!=='29369'||state.snapshot.roster.find(p=>p.id==='29235')?.slot!==null)throw Error('sandbox_baseline_changed_requires_reconciliation');
 const historical=JSON.parse(await readFile(join(privateRoot,'automatic-manager-2026-09-10/activation-2026-09-11/swap-proof/operator-reconciliation.json'),'utf8'));
 if(historical.outcome!=='not_applied')throw Error('historical_swap_unresolved');
 const opensAt=new Date().toISOString(),expiresAt=new Date(Date.now()+10*60000).toISOString();
 const approvalReference='Aaron explicit disposable setup and one lineup swap approval in task 01a08d0d-d568-7890-a947-c0f20059dbe2, September 11; continued build instruction 1549548404848332801 September 15';
 const config={profileId:binding.profileId,emergencyStopPath,pendingClaimsPageUrl:null,
  execution:{...binding,writesEnabled:mode==='execute',releaseSha,runningSha:releaseSha,verifiedCapabilities:[],acceptanceTest:{leagueId:binding.leagueId,teamId:binding.teamId,actionId,expiresAt,approvalReference},policy:{tradesEnabled:false,allowedActions:['set_lineup'],windows:[{kind:'set_lineup',opensAt,closesAt:expiresAt}]}},
  approval:{context:'disposable',leagueId:binding.leagueId,teamId:binding.teamId,profileId:binding.profileId,actionId,expiresAt,approvalReference,isolatedSessionVerified:true,recoveryVerified:true},
  browserLedger:{exclusive:async(scope,run)=>{if(scope!==`yahoo-owned-browser:${binding.profileId}`)throw Error('lease_scope');return run();},get:id=>browserLedger.get(id),put:e=>browserLedger.put(e),hasUnresolved:(s,id)=>browserLedger.hasUnresolved(s,id)}};
 await writeFile(join(dir,'acceptance-plan.json'),JSON.stringify({state,action,config:{...config,browserLedger:undefined},historicalReconciliation:historical})+'\n',{flag:'wx',mode:0o600});
 if(mode==='inspect'){console.log(JSON.stringify({status:'inspected_not_executed',action,actionId,dir}));return;}
 actionStarted=true;const receipt=await runGuardedOwnedAction(state.snapshot,action,config,driver,ledger);
 await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
 await page.screenshot({path:join(dir,'readback.png'),fullPage:true});console.log(JSON.stringify({receipt,dir}));
}));}catch(e){console.log(JSON.stringify({status:actionStarted?'uncertain':'blocked',code:/^[a-z_]+$/.test(e.message)?e.message:'owned_acceptance_failed',dir}));process.exitCode=1;}
