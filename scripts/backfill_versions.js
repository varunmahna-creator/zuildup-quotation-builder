#!/usr/bin/env node
/**
 * Phase 9I Part D (2026-06-24) — backfill clientKey + version onto Firestore `quotes`.
 *
 * The STATE is the source of truth for the customer name; the index `name` /
 * `customer_name` fields are the CORRUPTED ones we are repairing. For each doc:
 *   1. derive clientKey from state.customer.name (slug)
 *   2. within each clientKey group, assign version by created_at ascending
 *      (oldest = V1)
 *   3. write state.clientKey + state.version, top-level client_key + version
 *   4. rewrite index name to "<state.customer.name> — V<n>"
 *   5. preserve created_at; bump modified_at only when the doc actually changes
 *
 * DRY-RUN by default. Pass --apply to write. Without --apply it prints the plan
 * and writes scripts/backfill_report.txt.
 *
 * Usage:
 *   node scripts/backfill_versions.js            # dry-run + report
 *   node scripts/backfill_versions.js --apply    # write changes
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.FIRESTORE_PROJECT_ID || 'zuildup-quotes';
const COLLECTION = process.env.FIRESTORE_COLLECTION || 'quotes';
const REPORT_PATH = path.join(__dirname, 'backfill_report.txt');

// MUST match clientKeySlug() in app/quote.js exactly.
function clientKeySlug(name) {
  const s = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.replace(/ /g, '-') : '';
}

function stateCustomerName(d) {
  try {
    return (d.state && d.state.customer && d.state.customer.name) || '';
  } catch (_) { return ''; }
}

(async () => {
  const firestore = new Firestore({ projectId: PROJECT, databaseId: '(default)', ignoreUndefinedProperties: true });
  const out = [];
  const log = (line) => { out.push(line); console.log(line); };

  log('=== backfill_versions.js ' + (APPLY ? '[APPLY]' : '[DRY-RUN]') + ' ' + new Date().toISOString() + ' ===');
  log('project=' + PROJECT + ' collection=' + COLLECTION);

  const snap = await firestore.collection(COLLECTION).get();
  const docs = [];
  snap.forEach(s => docs.push({ id: s.id, data: s.data() }));
  log('Total docs read: ' + docs.length);

  // Group by clientKey derived from STATE customer name.
  const groups = new Map(); // clientKey -> [{id, data, custName, createdAt}]
  const noNameDocs = [];
  for (const doc of docs) {
    const custName = stateCustomerName(doc.data).trim();
    const ck = clientKeySlug(custName);
    const createdAt = doc.data.created_at || doc.data.modified_at || '';
    const rec = { id: doc.id, data: doc.data, custName, createdAt, ck };
    if (!ck) { noNameDocs.push(rec); continue; }
    if (!groups.has(ck)) groups.set(ck, []);
    groups.get(ck).push(rec);
  }

  log('Client groups (with derivable name): ' + groups.size);
  log('Docs with NO derivable state.customer.name: ' + noNameDocs.length);

  let retitleCount = 0;
  let changeCount = 0;
  const now = new Date().toISOString();
  const plan = []; // batched writes

  // Sort groups alphabetically for a stable report.
  const sortedKeys = Array.from(groups.keys()).sort();
  for (const ck of sortedKeys) {
    const arr = groups.get(ck);
    // version by created_at ascending (oldest = V1); tie-break by id for stability.
    arr.sort((a, b) => {
      const c = (a.createdAt || '').localeCompare(b.createdAt || '');
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });
    arr.forEach((rec, i) => {
      const version = i + 1;
      const newName = (rec.custName || 'Untitled') + ' \u2014 V' + version;
      const oldName = rec.data.name || '';
      const oldState = rec.data.state || {};
      const stateChanged = (oldState.clientKey !== ck) || (oldState.version !== version);
      const nameChanged = oldName !== newName;
      const topChanged = (rec.data.client_key !== ck) || (rec.data.version !== version);
      const willChange = stateChanged || nameChanged || topChanged;
      if (nameChanged) retitleCount++;
      if (willChange) changeCount++;
      plan.push({ rec, ck, version, newName, oldName, willChange });
    });
  }

  // ---- Report: per-group summary (compact) ----
  log('');
  log('--- PER-CLIENT VERSION PLAN ---');
  for (const ck of sortedKeys) {
    const arr = groups.get(ck);
    log('[' + ck + '] (' + arr.length + ' version' + (arr.length===1?'':'s') + ')');
    arr.forEach((rec, i) => {
      const version = i + 1;
      const newName = (rec.custName || 'Untitled') + ' \u2014 V' + version;
      log('    V' + version + '  ' + rec.id + '  created=' + (rec.createdAt||'?').slice(0,10)
        + '  "' + (rec.data.name||'') + '"  ->  "' + newName + '"');
    });
  }

  if (noNameDocs.length) {
    log('');
    log('--- DOCS WITH NO state.customer.name (left untouched, flagged) ---');
    for (const rec of noNameDocs) {
      log('    ' + rec.id + '  index_name="' + (rec.data.name||'') + '"  index_customer_name="' + (rec.data.customer_name||'') + '"');
    }
  }

  // ---- SPECIAL CASE: Sohail Dhir recovery ----
  log('');
  log('--- SOHAIL DHIR SPECIAL CASE ---');
  const sohailIntactId = 'q_mq7nw9v4_jql65v';
  const sohailCorruptId = 'q_mq2cmjvu_umzrc3';
  const intact = docs.find(d => d.id === sohailIntactId);
  if (intact) {
    const nm = stateCustomerName(intact.data);
    const ck = clientKeySlug(nm);
    const grp = groups.get(ck) || [];
    const idx = grp.findIndex(r => r.id === sohailIntactId);
    const ver = idx >= 0 ? (idx + 1) : '?';
    log('INTACT quote ' + sohailIntactId + ': state.customer.name="' + nm + '"');
    log('  -> clientKey="' + ck + '", will be retitled to "' + nm + ' \u2014 V' + ver + '". STATE LEFT UNTOUCHED.');
  } else {
    log('INTACT quote ' + sohailIntactId + ' NOT FOUND in collection.');
  }
  const corrupt = docs.find(d => d.id === sohailCorruptId);
  if (corrupt) {
    const nm = stateCustomerName(corrupt.data);
    log('CORRUPT doc ' + sohailCorruptId + ' (index titled "' + (corrupt.data.name||'') + '")');
    log('  -> its state.customer.name is actually "' + nm + '" (Raghav Mohta\'s data).');
    log('  -> NOT recoverable to Sohail (corruption predates PITR window). This backfill will');
    log('     retitle it to match its ACTUAL state owner ("' + nm + ' \u2014 V<n>"), NOT Sohail.');
    log('  -> FLAG: a quote titled "Sohail Dhir Structure" containing Raghav Mohta data is');
    log('     unrecoverable; if a real Sohail structure quote is needed it must be rebuilt.');
  } else {
    log('CORRUPT doc ' + sohailCorruptId + ' NOT FOUND in collection.');
  }

  // ---- Summary ----
  log('');
  log('--- SUMMARY ---');
  log('Total quotes:        ' + docs.length);
  log('Total client groups: ' + groups.size + (noNameDocs.length ? (' (+' + noNameDocs.length + ' nameless docs untouched)') : ''));
  log('Docs that would change: ' + changeCount);
  log('Index retitles:         ' + retitleCount);
  log('Mode: ' + (APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes)'));

  // ---- Write report ----
  fs.writeFileSync(REPORT_PATH, out.join('\n') + '\n', 'utf8');
  console.log('\nReport written to ' + REPORT_PATH);

  if (!APPLY) {
    console.log('DRY-RUN complete. Re-run with --apply to write changes.');
    return;
  }

  // ---- APPLY ----
  console.log('\nApplying ' + changeCount + ' changes in batches...');
  let batch = firestore.batch();
  let pending = 0, written = 0;
  for (const p of plan) {
    if (!p.willChange) continue;
    const ref = firestore.collection(COLLECTION).doc(p.rec.id);
    const newState = Object.assign({}, p.rec.data.state || {});
    newState.clientKey = p.ck;
    newState.version = p.version;
    batch.update(ref, {
      name: p.newName,
      client_key: p.ck,
      version: p.version,
      state: newState,
      modified_at: now,
    });
    pending++; written++;
    if (pending >= 400) { await batch.commit(); batch = firestore.batch(); pending = 0; console.log('  committed ' + written + '...'); }
  }
  if (pending > 0) await batch.commit();
  console.log('APPLY complete. ' + written + ' docs updated.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
