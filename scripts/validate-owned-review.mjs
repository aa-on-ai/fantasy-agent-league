import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {runSeasonManager} from '../dist/src/runtime/season-run.js';
const root=resolve(new URL('..',import.meta.url).pathname),requestPath=resolve(process.argv[2]??''),packetPath=resolve(process.argv[3]??'');
const allowed=join(root,'runtime/private/owned-reviews/');if(!requestPath.startsWith(allowed)||dirname(packetPath)!==dirname(requestPath))throw Error('unbound_review_paths');
const request=JSON.parse(await readFile(requestPath,'utf8')),packet=JSON.parse(await readFile(packetPath,'utf8'));
const receipt=await runSeasonManager({context:request.context,binding:request.binding,mode:'review',emergencyStopPath:join(root,'runtime/private/emergency-stop'),receiptDirectory:join(dirname(requestPath),'receipts'),decide:async()=>packet});
console.log(JSON.stringify(receipt));
