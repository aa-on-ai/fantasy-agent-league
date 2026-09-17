import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {withOwnedBrowser,OWNED_BROWSER_PROFILE,YahooOwnedDriver,dismissOwnedOptionalPrompt} from '../dist/src/platforms/yahoo/owned-browser.js';
import {captureOwnedObservation,normalizeOwnedAssessment,validateOwnedObservation,readOwnedRules,readOwnedPool,readOwnedRoster} from '../dist/src/platforms/yahoo/owned-sources.js';
import {captureOwnedClaimPage,collectOwnedClaims} from '../dist/src/platforms/yahoo/owned-claims.js';
import {ownedAcquisitionDeadline} from '../dist/src/platforms/yahoo/owned-acquisition.js';
import {runGuardedOwnedAction} from '../dist/src/platforms/yahoo/guarded-owned.js';
import {FileLedger} from '../dist/src/execution/file-ledger.js';
import {actionFingerprint} from '../dist/src/execution/coordinator.js';
import {readStop} from '../dist/src/runtime/native-read-proof.js';

// One previously authorized disposable acceptance. No production scope or
// arbitrary action flags. Re-running an uncertain action reconciles only.
const root=resolve(new URL('..',import.meta.url).pathname),privateRoot=join(root,'runtime/private');
const mode=process.argv[2];if(!['inspect','stage','execute'].includes(mode))throw Error('explicit_mode_required');
const acceptance=process.argv[3]??'waiver';if(!['waiver','pickup'].includes(acceptance))throw Error('unknown_acceptance');
const kind=acceptance==='waiver'?'waiver_claim':'add_drop',phase=acceptance==='waiver'?'waivers':'free_agents';
const pickupIntentPath=join(privateRoot,'owned-pickup-acceptance.json');
let pickupIntent=null;try{pickupIntent=JSON.parse(await readFile(pickupIntentPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const releaseSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain','--','src','scripts/owned-sandbox-acquisition.mjs'],{cwd:root,encoding:'utf8'}).trim())throw Error('acceptance_source_not_pinned');
const dir=join(privateRoot,acceptance==='waiver'?'owned-sandbox-waiver':'owned-sandbox-pickup',new Date().toISOString().replaceAll(':','-'));await mkdir(dir,{recursive:true,mode:0o700});
const binding={leagueId:'1659459',teamId:'1',teamName:'Stiff Arm ae',profileId:'fantasy-agent-1-owned-chrome',season:2026,period:'2',maxAgeMs:900000};
const origin='https://football.fantasysports.yahoo.com',team=origin+'/f1/1659459/1',emergencyStopPath=join(privateRoot,'emergency-stop');
const ledger=new FileLedger(join(privateRoot,'action-ledger')),browserLedger=new FileLedger(join(privateRoot,'browser-ledger'));
const save=(name,value)=>writeFile(join(dir,name+'.json'),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600,flush:true});
const record=o=>save(o.observationId,o);
const checkpoint=async()=>{if(await readStop(emergencyStopPath)!=='clear')throw Error('emergency_stop');};
let actionStarted=false,submittedRequests=0,previewRequests=0;
try { await browserLedger.exclusive('yahoo-owned-browser:'+binding.profileId,()=>withOwnedBrowser({profilePath:OWNED_BROWSER_PROFILE},async page=>{
  let armed=false,preparing=false,selectedAddId=acceptance==='waiver'?'34218':null,selectedDropId=acceptance==='waiver'?'29235':'29369';
  if(acceptance==='pickup'&&pickupIntent){
    if(pickupIntent.leagueId!==binding.leagueId||pickupIntent.teamId!==binding.teamId||pickupIntent.dropId!=='29369'||!/^\d+$/.test(pickupIntent.addId)||!pickupIntent.actionId)throw Error('invalid_pickup_acceptance_intent');
    if((await ledger.get(pickupIntent.actionId))?.status==='verified'){console.log(JSON.stringify({status:'already_verified',actionId:pickupIntent.actionId,dir}));return;}
    selectedAddId=pickupIntent.addId;
  }
  await page.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.origin===origin&&!['GET','HEAD'].includes(r.method())){
      const p=new URLSearchParams(r.postData()??'');
      // The observed stage-2 POST renders the confirmation; only stage 3
      // submits the claim. Bind both to the exact disposable add/drop pair.
      if(preparing&&previewRequests===0&&r.method()==='POST'&&!r.isNavigationRequest()&&['xhr','fetch'].includes(r.resourceType())&&u.pathname==='/f1/1659459/1/addplayer'&&
        selectedAddId&&p.getAll('stage').length===1&&p.get('stage')==='2'&&p.getAll('apid').length===1&&p.get('apid')===selectedAddId&&
        p.getAll('dpid').length===1&&p.get('dpid')===selectedDropId){previewRequests++;return route.fallback();}
      if(mode!=='execute'||!armed||submittedRequests!==0||r.method()!=='POST'||!r.isNavigationRequest()||
        u.pathname!=='/f1/1659459/1/addplayer'||p.getAll('stage').length!==1||p.get('stage')!=='3'||
        !selectedAddId||p.getAll('apid').length!==1||p.get('apid')!==selectedAddId||p.getAll('dpid').length!==1||p.get('dpid')!==selectedDropId)return route.abort();
      submittedRequests++;
    }
    return route.fallback();
  });
  const first=await captureOwnedClaimPage(page,binding,record,checkpoint);
  const link=(label,path)=>{
    const urls=[...new Set(first.observation.dom.links.filter(l=>l.text.trim()===label&&new URL(l.href).origin===origin&&new URL(l.href).pathname===path).map(l=>l.href))];
    if(urls.length!==1)throw Error('unobserved_source_link');return urls[0];
  };
  const capture=async url=>{await checkpoint();await page.goto(url,{waitUntil:'load',timeout:20000});await dismissOwnedOptionalPrompt(page);const o=await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(o,binding);await record(o);return o;};
  const settings=first.observation.dom.links.find(l=>l.href===origin+'/f1/1659459/settings');if(!settings)throw Error('settings_link_unobserved');
  const rulesObservation=await capture(settings.href),rules=readOwnedRules(rulesObservation,binding);
  const drops=await capture(link('Drop Player','/f1/1659459/1/dropplayer'));
  let pool=await capture(link('Players','/f1/1659459/players'));
  if(!pool.dom.controls.some(c=>c.name==='stat1'&&c.value==='S_PW_2')){
    const form=pool.dom.forms.find(f=>f.method==='get'&&new URL(f.action).pathname==='/f1/1659459/players'&&f.controls.some(c=>c.name==='stat1'&&c.options.some(o=>o.value==='S_PW_2')));
    if(!form)throw Error('projection_filter_unobserved');const u=new URL(form.action);u.searchParams.set('stat1','S_PW_2');u.searchParams.set('status','A');u.searchParams.set('pos','O');pool=await capture(u.href);
  }
  const candidates=readOwnedPool(pool,rules,binding);
  const candidate=selectedAddId?candidates.players.find(p=>p.id===selectedAddId):candidates.players.filter(p=>p.availability==='free_agent'&&p.eligible.includes('QB')&&p.addControlObserved).sort((a,b)=>b.projectedPoints-a.projectedPoints)[0];
  if(!candidate||candidate.availability!==(acceptance==='waiver'?'waivers':'free_agent'))throw Error(acceptance==='waiver'?'authorized_candidate_not_on_waivers':'free_agent_candidate_unavailable');
  selectedAddId=candidate.id;
  const deadline=ownedAcquisitionDeadline(candidate,rules,2026,new Date());if(!deadline)throw Error('acquisition_deadline_unknown_or_closed');
  const collect=async()=>{
    const evidence=await collectOwnedClaims(page,binding,rules,record,checkpoint);
    await save('claims-'+Date.now(),{evidence});return evidence;
  };
  const normalize=async observation=>{
    // Once the added player appears on the independent roster reload, use the
    // roster-only readback. The old pre-submit pool must not duplicate that
    // now-owned player or masquerade as a fresh acquisition assessment.
    const readbackOnly=acceptance==='pickup'&&readOwnedRoster(observation,rules,binding).players.some(p=>p.id===selectedAddId);
    const a=normalizeOwnedAssessment({roster:observation,rules:rulesObservation,pools:[pool],drops},binding,readbackOnly?'lineup':phase);
    if(!a.snapshot)throw Error('invalid_sandbox_acquisition_snapshot');
    const dropDeadline=a.lineupDeadlines[selectedDropId];
    // After a pickup, the removed player is absent. The independent readback
    // does not authorize another dispatch and needs no new drop deadline.
    if(!dropDeadline&&a.snapshot.roster.some(p=>p.id===selectedDropId))throw Error('drop_deadline_unobserved');
    return {observation,snapshot:a.snapshot,lineupDeadlines:a.lineupDeadlines,acquisitionDeadlines:{[selectedAddId]:deadline,...(dropDeadline?{[selectedDropId]:new Date(Math.min(Date.parse(deadline),Date.parse(dropDeadline))).toISOString()}:{})},pendingClaims:await collect()};
  };
  const driver=new YahooOwnedDriver(page,{binding,profileId:binding.profileId,emergencyStopPath,allowSubmission:mode!=='inspect',normalize,record,collectPendingClaims:collect,
    atomicSwapEvidence:null,swapSelection:null,atomicAcquisitionEvidence:'runtime/private/owned-manager-2026-09-15/sandbox-waiver-hydrated-evidence-2026-09-15T22-57-12.773Z.json'});
  const state=await driver.read();
  if(acceptance==='pickup'&&state.snapshot.roster.find(p=>p.id===selectedDropId)?.slot!==null)throw Error('pickup_drop_must_be_benched');
  if(acceptance==='pickup'&&(!state.pendingClaims||state.pendingClaims.claims.some(c=>c.dropId===selectedDropId||c.addId===selectedAddId)))throw Error('pickup_pending_claim_conflict_or_unknown');
  const action={kind,addId:selectedAddId,dropId:selectedDropId,improvement:candidate.projectedPoints-state.snapshot.roster.find(p=>p.id===selectedDropId).projectedPoints};
  const actionId=actionFingerprint(state.snapshot,action),previous=await ledger.get(actionId);
  if(previous?.status==='verified'){console.log(JSON.stringify({status:'already_verified',actionId,dir}));return;}
  if(!previous&&!state.pendingClaims)throw Error('pending_claim_readback_unavailable');
  const opensAt=new Date().toISOString(),expiresAt=new Date(Math.min(Date.now()+600000,Date.parse(deadline))).toISOString();
  const approvalReference=`Aaron approved one disposable ${acceptance}, task 01a08d0d-d568-7890-a947-c0f20059dbe2; continued completion instructions 1549607759861776475 and 1549628160088350761`;
  const config={profileId:binding.profileId,emergencyStopPath,pendingClaimsPageUrl:team,
    execution:{...binding,writesEnabled:mode==='execute',releaseSha,runningSha:releaseSha,verifiedCapabilities:[],acceptanceTest:{leagueId:binding.leagueId,teamId:binding.teamId,actionId,expiresAt,approvalReference},policy:{tradesEnabled:false,allowedActions:[kind],windows:[{kind,opensAt,closesAt:expiresAt}]}},
    approval:{context:'disposable',leagueId:binding.leagueId,teamId:binding.teamId,profileId:binding.profileId,actionId,expiresAt,approvalReference,isolatedSessionVerified:true,recoveryVerified:true},
    browserLedger:{exclusive:async(scope,run)=>{if(scope!=='yahoo-owned-browser:'+binding.profileId)throw Error('lease_scope');return run();},get:id=>browserLedger.get(id),put:e=>browserLedger.put(e),hasUnresolved:(s,id)=>browserLedger.hasUnresolved(s,id)}};
  await save('acceptance-plan',{state,action,config:{...config,browserLedger:undefined},previous,deadlineEvidence:{interpretation:'conservative_documented_weekly_cutoff',deadline,waiverDate:candidate.waiverDateText,rule:rules.weeklyWaivers,reference:'https://help.yahoo.com/kb/sports/customize-weekly-waivers-settings-sln8825.html'}});
  if(mode==='inspect'){console.log(JSON.stringify({status:'inspected_not_executed',action,actionId,queue:state.pendingClaims?.interpretation,deadline,dir}));return;}
  if(mode==='stage'){
    preparing=true;let ticket;try{ticket=await driver.prepare(action,state);}finally{preparing=false;}
    await save('staged',{status:'exact_confirmation_not_submitted',ticket,previewRequests,submittedRequests});
    await page.screenshot({path:join(dir,'confirmation.png'),fullPage:true});
    console.log(JSON.stringify({status:'exact_confirmation_not_submitted',previewRequests,submittedRequests,dir}));return;
  }
  if(acceptance==='pickup'){
    if(pickupIntent&&pickupIntent.actionId!==actionId)throw Error('pickup_intent_conflict');
    if(!pickupIntent)await writeFile(pickupIntentPath,JSON.stringify({leagueId:binding.leagueId,teamId:binding.teamId,addId:selectedAddId,dropId:selectedDropId,actionId,plan:join(dir,'acceptance-plan.json')})+'\n',{flag:'wx',mode:0o600,flush:true});
  }
  const transport={read:()=>driver.read(),prepare:async(a,s)=>{preparing=true;try{return await driver.prepare(a,s);}catch(e){await save('prepare-failure',{code:/^[a-z_]+$/.test(e.message)?e.message:'preview_failed'});throw e;}finally{preparing=false;}},readback:()=>driver.readback(),commit:async(t,check)=>{armed=true;try{await driver.commit(t,check);}finally{armed=false;}}};
  actionStarted=true;const receipt=await runGuardedOwnedAction(state.snapshot,action,config,transport,ledger);
  await save('receipt',{...receipt,submittedRequests,previewRequests});await page.screenshot({path:join(dir,'readback.png'),fullPage:true});
  console.log(JSON.stringify({receipt,submittedRequests,previewRequests,dir}));
})); }catch(e){await save('failure',{status:actionStarted?'uncertain':'blocked',code:/^[a-z_]+$/.test(e.message)?e.message:'owned_acceptance_failed',submittedRequests});console.log(JSON.stringify({status:actionStarted?'uncertain':'blocked',code:e.message,submittedRequests,dir}));process.exitCode=1;}
