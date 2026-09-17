import type {Page} from 'playwright-core';
import {dismissOwnedOptionalPrompt} from './owned-browser.js';
import {captureOwnedObservation,normalizeOwnedAssessment,readOwnedRoster,readOwnedRules,validateOwnedObservation,type OwnedBinding,type OwnedObservation,type OwnedAssessmentInput} from './owned-sources.js';
/** Fresh lineup assessment from the owned page. Partial capture cannot claim readiness. */
export async function collectOwnedLineup(page:Page,binding:OwnedBinding,record:(o:OwnedObservation)=>Promise<void>,checkpoint:()=>Promise<void>,clock:()=>Date=()=>new Date()) {
 const origin='https://football.fantasysports.yahoo.com',teamPath=`/f1/${binding.leagueId}/${binding.teamId}`;
 const observe=async()=>{await checkpoint();await page.waitForLoadState('load',{timeout:10000});await dismissOwnedOptionalPrompt(page);const o=await captureOwnedObservation(page,binding.profileId,clock);validateOwnedObservation(o,binding,clock());await record(o);return o;};
 const navigate=async(url:string)=>{await checkpoint();const u=new URL(url);if(u.origin!==origin||!u.pathname.startsWith(`/f1/${binding.leagueId}/`))throw Error('unowned_source_navigation');await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});return observe();};
 const initial=await navigate(origin+teamPath);
 const settings=initial.dom.links.filter(l=>new URL(l.href).origin===origin&&new URL(l.href).pathname===`/f1/${binding.leagueId}/settings`);
 if(!settings.length)throw Error('settings_link_unobserved');
 const rules=await navigate(settings[0]!.href), roster=await navigate(origin+teamPath);
 const parsed=readOwnedRoster(roster,readOwnedRules(rules,binding,clock()),binding,clock());
 const details:NonNullable<OwnedAssessmentInput['playerDetails']>=[],gaps:string[]=[];
 for(const player of parsed.players){
  await checkpoint();
  if(!player.newsLink){gaps.push(`news_control_unobserved:${player.id}`);continue;}
  const exact=page.locator(`a[aria-label=${JSON.stringify('Open player notes for '+player.name)}]`);
  try{
   if(await exact.count()!==1)throw Error('ambiguous_player_note_control');
   const selected = page.locator('a.player-name').filter({hasText:player.name});
   await exact.click({timeout:7000});
   try { await selected.waitFor({state:'visible',timeout:7000}); }
   catch {
     // One read-only hydration repair, only when no player card opened. Never
     // repeat transaction gestures or click through a different modal.
     const failed = await captureOwnedObservation(page,binding.profileId,clock);
     await record(failed);
     if (failed.dom.links.some(l => /(?:^|\s)player-name(?:\s|$)/.test(l.attributes.class ?? ''))) throw Error('wrong_player_card');
     validateOwnedObservation(failed,binding,clock());
     await checkpoint();await exact.click({timeout:7000});
     await selected.waitFor({state:'visible',timeout:7000});
   }
   await page.getByRole('heading',{name:'Latest News',exact:true}).waitFor({state:'visible',timeout:7000});
   details.push({playerId:player.id,playerName:player.name,observation:await observe()});
  }catch{gaps.push(`player_detail_capture_failed:${player.id}`);}
  // Fresh navigation clears the modal and stale selection without relying on an unlabelled close button.
  await navigate(origin+teamPath);
 }
 const finalRoster=await observe();
 const assessment=normalizeOwnedAssessment({roster:finalRoster,rules,playerDetails:details},binding,'lineup',clock());
 assessment.gaps.push(...gaps);if(gaps.length)assessment.readiness.lineup=false;
 return assessment;
}
