import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { assertOwnedProfile } from './readiness-owned-browser.mjs';

const [teamPath, targetUrl, label, inspectMode] = process.argv.slice(2);
const origin = 'https://football.fantasysports.yahoo.com';
if (!/^\/f1\/(425299\/11|1659459\/1)$/.test(teamPath ?? '') || !/^[a-z0-9-]+$/.test(label ?? '')) throw new Error('invalid_inspection_binding');
const target = new URL(targetUrl ?? origin + teamPath);
const league = teamPath.split('/')[2];
if (target.origin !== origin || !target.pathname.startsWith(`/f1/${league}`)) throw new Error('invalid_inspection_target');
const destination = new URL('../runtime/private/owned-manager-2026-09-15/', import.meta.url);
await mkdir(destination, { recursive: true, mode: 0o700 });
await assertOwnedProfile();
let browser;
try {
  browser = await chromium.launchPersistentContext(join(homedir(), '.local/share/fantasy-agent-league/2026/agent-1/browser'), {
    channel: 'chrome', headless: true, chromiumSandbox: true, acceptDownloads: false, serviceWorkers: 'block', timeout: 15000,
  });
  const page = await browser.newPage();
  const navigationRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && (request.isNavigationRequest() || !['GET','HEAD'].includes(request.method())))
      navigationRequests.push({method:request.method(),path:url.pathname,navigation:request.isNavigationRequest()});
  });
  await page.route('**/*', route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const u = new URL(request.url());
      if (![origin, 'https://login.yahoo.com'].includes(u.origin)) return route.abort();
      if (!['GET','HEAD'].includes(request.method())) return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin + teamPath, { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (new URL(page.url()).origin !== origin) throw new Error('browser_auth_required');
  await page.getByRole('link', { name: 'My Team', exact: true }).first().waitFor({ state: 'attached', timeout: 7000 });
  const owns = async () => page.evaluate(expected => {
    const paths = [...document.querySelectorAll('a[href]')].filter(a => a.textContent.trim() === 'My Team').map(a => new URL(a.href).pathname);
    return paths.length > 0 && paths.every(p => p === expected);
  }, teamPath);
  if (!await owns()) throw new Error('wrong_team');
  if (target.href !== page.url()) await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (new URL(page.url()).origin !== origin || !await owns()) throw new Error('wrong_team_or_auth');
  if (teamPath === '/f1/1659459/1' && new URL(page.url()).pathname === '/f1/1659459/selectmanager') {
    const choice = page.locator('select[name=mid]');
    if (await choice.locator('option[value="1"]').innerText() !== 'Stiff Arm ae') throw new Error('wrong_sandbox_choice');
    await choice.selectOption('1');
    await page.getByRole('button', {name:'Select Team',exact:true}).click();
    await page.waitForURL(url => url.pathname !== '/f1/1659459/selectmanager', {waitUntil:'domcontentloaded',timeout:10000});
    if (!await owns()) throw new Error('wrong_team_after_choice');
  }
  await page.waitForLoadState('load', {timeout:10000});
  if (inspectMode === 'lineup-source') {
    if (teamPath !== '/f1/1659459/1' || new URL(page.url()).pathname !== teamPath) throw new Error('wrong_selection_target');
    await page.getByRole('button', { name: 'Click here to edit QB Dak Prescott', exact: true }).click();
    // Selecting a source only opens choices. No destination is clicked.
  } else if (inspectMode === 'waiver-drop-selection') {
    if (teamPath !== '/f1/1659459/1' || new URL(page.url()).searchParams.get('apid') !== '34218') throw new Error('wrong_waiver_inspection');
    await page.locator('button[data-check-box-value="29235 "][title="Click to drop this player"]').click();
    // Only selecting the drop candidate. Final submission remains blocked.
    await page.getByRole('button', {name:'Create claim to Add Brock Purdy, Drop Jared Goff',exact:true})
      .waitFor({state:'visible',timeout:10000});
  } else if (inspectMode?.startsWith('player-note:')) {
    const playerName = inspectMode.slice('player-note:'.length);
    const note = page.locator(`a[aria-label=${JSON.stringify('Open player notes for ' + playerName)}]`);
    await note.click();
    // A player may have no season game log; identity is the load-bearing modal witness.
    await page.locator('a.player-name').filter({hasText:playerName}).waitFor({state:'visible',timeout:7000});
  } else if (inspectMode) throw new Error('unsupported_inspection_mode');
  const observed = await page.evaluate(() => {
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const safeUrl = href => {
      try {
        const u = new URL(href, location.href);
        if (!['football.fantasysports.yahoo.com', 'sports.yahoo.com'].includes(u.hostname)) return null;
        if (/invite|joinleague|acceptinvite|logout|login|delete|renew|payment/i.test(u.pathname)) return null;
        for (const key of [...u.searchParams.keys()]) if (/token|crumb|auth|key|code|invite|sig/i.test(key)) u.searchParams.delete(key);
        u.hash = ''; return u.href;
      } catch { return null; }
    };
    const attrs = el => Object.fromEntries([...el.attributes].filter(a => /^(id|class|role|title|aria-|data-)/.test(a.name) && !/token|crumb|auth|secret|key|sig/i.test(a.name)).map(a => [a.name, a.value]));
    const links = root => [...root.querySelectorAll('a[href]')].filter(visible).map(el => ({ text: el.innerText.trim(), href: safeUrl(el.href), title: el.title || null, attrs: attrs(el) })).filter(x => x.href);
    const controls = root => [...root.querySelectorAll('button,input:not([type=hidden]):not([type=password]),select,[role=button]')].filter(visible).map(el => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), name: el.getAttribute('name'),
      id: el.id || null, text: el.innerText.trim(), ariaLabel: el.getAttribute('aria-label'), title: el.title || null,
      disabled: !!el.disabled, selected: el.getAttribute('aria-selected'), expanded: el.getAttribute('aria-expanded'), attrs: attrs(el),
      value: el.tagName === 'SELECT' || ['radio','checkbox','submit','button'].includes(el.getAttribute('type')) ? el.value : null,
      form: el.form ? { action: safeUrl(el.form.action), method: el.form.method } : null,
      options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ text: o.text, value: o.value, selected: o.selected })) : undefined,
    }));
    return { schemaVersion: 1, evidenceType: 'owned_browser_dom', url: safeUrl(location.href), title: document.title, text: document.body.innerText,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].filter(visible).map(el => el.innerText.trim()),
      links: links(document), controls: controls(document), forms: [...document.forms].filter(visible).map(form => ({action:safeUrl(form.action),method:form.method,controls:controls(form)})),
      tables: [...document.querySelectorAll('table')].filter(visible).map(table => ({ caption: table.caption?.innerText ?? '',
        headers: [...table.querySelectorAll('thead tr')].map(row => [...row.querySelectorAll('th,td')].map(el => el.innerText.trim())),
        rows: [...table.querySelectorAll('tbody tr')].map(row => ({ cells: [...row.querySelectorAll(':scope > th,:scope > td')].map(el => el.innerText.trim()), links: links(row), controls: controls(row), attrs:attrs(row) })),
      })),
    };
  });
  observed.capturedAt = new Date().toISOString();
  observed.navigationRequests = navigationRequests;
  observed.numericFormFields = await page.evaluate(() => [...document.forms].map(form => ({
    action:new URL(form.action).origin === location.origin ? new URL(form.action).pathname : null,
    fields:[...form.querySelectorAll('input')].filter(el => ['apid','dpid','mid','stage','week'].includes(el.name) && /^\d+$/.test(el.value)).map(el => ({name:el.name,value:el.value}))
  })).filter(form => form.action));
  observed.queueLinks = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
    .filter(a => /waiver|pending|transaction/i.test(a.textContent + ' ' + a.getAttribute('href')))
    .map(a => ({text:a.textContent.trim(),href:a.href,visible:!!a.getClientRects().length}))
    .filter(a => new URL(a.href).origin === location.origin));
  observed.aria = await page.locator('body').ariaSnapshot();
  const filename = `${label}-${observed.capturedAt.replaceAll(':', '-')}.json`;
  await writeFile(new URL(filename, destination), JSON.stringify(observed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await page.screenshot({ path: new URL(filename.replace('.json', '.png'), destination).pathname, fullPage: true });
  console.log(JSON.stringify({ file: filename, url: observed.url, capturedAt: observed.capturedAt, tables: observed.tables.length, rows: observed.tables.reduce((n,t) => n+t.rows.length,0), headings: observed.headings }));
} finally { if (browser) await browser.close(); }
