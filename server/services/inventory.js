// Inventory: receiving, QA, issuing, returns, adjustments, physical inventory. Also light finance postings.
import { db } from '../store/index.js';
import { addDays, fail, now, num, r2, sum, today } from '../util.js';
import { journal } from './common.js';

const item = async id => await db.get('items', id) || fail(400, 'Item not found');
const bump = (it, delta) => db.update('items', it.id, { on_hand: r2(num(it.on_hand) + delta) });
const move = (row, user) => db.insert('stock_moves', { move_date: now(), qa_status: 'n/a', done_by: user.name, ...row });

// Incoming materials against a PO. Items flagged "QA required" wait in quarantine until inspected.
export async function receive({ po_id, lines }, user) {
  const po = await db.get('purchase_orders', po_id) || fail(404, 'PO not found');
  if (!['approved', 'partially received'].includes(po.status)) fail(400, 'Only approved POs can be received');
  const prior = await db.list('stock_moves', { po_id });
  let value = 0;
  for (const l of lines.filter(l => num(l.qty) > 0)) {
    const it = await item(l.item_id), pl = (po.lines || []).find(x => x.item_id === l.item_id);
    const cost = num(pl?.price) || num(it.unit_cost);
    await move({ move_type: 'receipt', item_id: it.id, qty: num(l.qty), unit_cost: cost, po_id, project_id: po.project_id, ref: po.po_no, qa_status: it.qa_required ? 'pending' : 'n/a' }, user);
    if (!it.qa_required) { await bump(it, num(l.qty)); value += num(l.qty) * cost; }
  }
  if (value) await journal(today(), po.po_no, 'Goods received', [['1300', value, 0], ['2000', 0, value]]);
  const all = [...prior, ...lines.map(l => ({ move_type: 'receipt', item_id: l.item_id, qty: num(l.qty) }))].filter(m => m.move_type === 'receipt');
  const done = (po.lines || []).filter(l => l.item_id).every(l => sum(all.filter(m => m.item_id === l.item_id), 'qty') >= num(l.qty));
  if (done && !(await db.list('bills', { po_id })).length)
    await db.insert('bills', { bill_no: await db.nextNo('bills', 'bill_no', 'BILL-'), supplier_id: po.supplier_id, po_id, bill_date: today(), due_date: addDays(today(), 30), amount: po.total, status: 'draft' });
  return db.update('purchase_orders', po_id, { status: done ? 'received' : 'partially received' });
}

export async function qa({ move_id, qty_accepted, remarks }, user) {
  const m = await db.get('stock_moves', move_id) || fail(404, 'Receipt not found');
  if (m.qa_status !== 'pending') fail(400, 'This receipt is not awaiting QA');
  const ok = Math.max(0, Math.min(num(m.qty), num(qty_accepted))), rejected = num(m.qty) - ok;
  const result = !rejected ? 'passed' : ok ? 'partial' : 'failed';
  await db.insert('qa_inspections', { move_id, item_id: m.item_id, qty_inspected: m.qty, qty_accepted: ok, qty_rejected: rejected, result, inspector: user.name, remarks, inspected_at: now() });
  if (ok) { await bump(await item(m.item_id), ok); await journal(today(), m.ref, 'Goods received (QA passed)', [['1300', ok * num(m.unit_cost), 0], ['2000', 0, ok * num(m.unit_cost)]]); }
  if (rejected) await move({ move_type: 'return out', item_id: m.item_id, qty: rejected, unit_cost: m.unit_cost, po_id: m.po_id, ref: m.ref, remarks: `QA rejected: ${remarks || ''}` }, user);
  return db.update('stock_moves', move_id, { qa_status: result });
}

export async function issue({ item_id, qty, project_id, remarks }, user) {
  const it = await item(item_id), q = num(qty);
  if (q <= 0) fail(400, 'Quantity must be greater than zero');
  if (q > num(it.on_hand)) fail(400, `Only ${num(it.on_hand)} ${it.uom || ''} of ${it.name} on hand`);
  const ref = await db.nextNo('stock_moves', 'ref', 'ISS-');
  await bump(it, -q);
  if (project_id) {
    const cost = r2(q * num(it.unit_cost));
    await db.insert('project_costs', { project_id, cost_date: today(), category: 'material', amount: cost, description: `Issued ${q} ${it.uom || ''} ${it.name}`, ref });
    await journal(today(), ref, 'Material issue', [['5000', cost, 0], ['1300', 0, cost]], project_id);
    const pm = (await db.list('project_materials', { project_id })).find(m => m.item_id === item_id);
    if (pm) await db.update('project_materials', pm.id, { qty_issued: num(pm.qty_issued) + q });
  }
  return move({ move_type: 'issue', item_id, qty: q, unit_cost: it.unit_cost, project_id, ref, remarks }, user);
}

// kind: 'from project' (back into stock, credits the project) or 'to supplier' (out of stock)
export async function returnStock({ item_id, qty, project_id, kind, remarks }, user) {
  const it = await item(item_id), q = num(qty);
  if (q <= 0) fail(400, 'Quantity must be greater than zero');
  const ref = await db.nextNo('stock_moves', 'ref', 'RET-');
  if (kind === 'to supplier') {
    if (q > num(it.on_hand)) fail(400, `Only ${num(it.on_hand)} on hand`);
    await bump(it, -q);
    await journal(today(), ref, 'Return to supplier', [['2000', q * num(it.unit_cost), 0], ['1300', 0, q * num(it.unit_cost)]]);
    return move({ move_type: 'return out', item_id, qty: q, unit_cost: it.unit_cost, ref, remarks }, user);
  }
  await bump(it, q);
  if (project_id) {
    const cost = r2(q * num(it.unit_cost));
    await db.insert('project_costs', { project_id, cost_date: today(), category: 'material', amount: -cost, description: `Returned ${q} ${it.uom || ''} ${it.name}`, ref });
    await journal(today(), ref, 'Material return', [['1300', cost, 0], ['5000', 0, cost]], project_id);
    const pm = (await db.list('project_materials', { project_id })).find(m => m.item_id === item_id);
    if (pm) await db.update('project_materials', pm.id, { qty_issued: Math.max(0, num(pm.qty_issued) - q) });
  }
  return move({ move_type: 'return in', item_id, qty: q, unit_cost: it.unit_cost, project_id, ref, remarks }, user);
}

export async function adjust({ item_id, qty, remarks }, user, ref) {
  const it = await item(item_id), q = num(qty);
  if (!q) fail(400, 'Enter a non-zero adjustment quantity');
  if (!remarks) fail(400, 'A reason is required for adjustments');
  await bump(it, q);
  const value = Math.abs(q) * num(it.unit_cost);
  await journal(today(), ref || 'ADJ', `Inventory adjustment: ${remarks}`, q > 0 ? [['1300', value, 0], ['5900', 0, value]] : [['5900', value, 0], ['1300', 0, value]]);
  return move({ move_type: 'adjustment', item_id, qty: q, unit_cost: it.unit_cost, ref: ref || await db.nextNo('stock_moves', 'ref', 'ADJ-'), remarks }, user);
}

// 4.8.1 Physical inventory: snapshot system quantities, enter counts, post variances as adjustments.
export async function startCount({ category, remarks }) {
  const items = (await db.list('items')).filter(i => !category || i.category === category).sort((a, b) => String(a.code).localeCompare(b.code));
  return db.insert('stock_counts', { count_no: await db.nextNo('stock_counts', 'count_no', 'PI-'), count_date: today(), status: 'draft', remarks,
    lines: items.map(i => ({ item_id: i.id, code: i.code, name: i.name, uom: i.uom, location: i.location, system_qty: num(i.on_hand), counted_qty: null })) });
}
export async function postCount(id, user) {
  const c = await db.get('stock_counts', id) || fail(404, 'Count not found');
  if (c.status === 'posted') fail(400, 'Count already posted');
  let adjusted = 0;
  for (const l of c.lines || []) {
    if (l.counted_qty === null || l.counted_qty === '') continue;
    const it = await item(l.item_id), diff = r2(num(l.counted_qty) - num(it.on_hand));
    l.variance = diff;
    if (diff) { await adjust({ item_id: l.item_id, qty: diff, remarks: `Physical inventory ${c.count_no}` }, user, c.count_no); adjusted++; }
  }
  await db.update('stock_counts', id, { status: 'posted', lines: c.lines });
  return { adjusted };
}

// ---- Finance helpers ----
export async function postInvoice(id) {
  const inv = await db.get('invoices', id) || fail(404, 'Invoice not found');
  if (inv.status !== 'draft') fail(400, 'Invoice already posted');
  await journal(inv.invoice_date || today(), inv.invoice_no, 'Customer invoice', [['1200', inv.amount, 0], ['4000', 0, inv.amount]], inv.project_id);
  return db.update('invoices', id, { status: 'posted', invoice_date: inv.invoice_date || today() });
}
export async function pay(table, id) {
  const doc = await db.get(table, id) || fail(404, 'Document not found');
  if (doc.status === 'paid') fail(400, 'Already paid');
  const ref = doc.invoice_no || doc.bill_no;
  await journal(today(), ref, 'Payment', table === 'invoices' ? [['1000', doc.amount, 0], ['1200', 0, doc.amount]] : [['2000', doc.amount, 0], ['1000', 0, doc.amount]]);
  return db.update(table, id, { status: 'paid' });
}
export async function trialBalance() {
  const [accounts, je] = await Promise.all([db.list('accounts'), db.list('journal_entries')]);
  return accounts.sort((a, b) => a.code.localeCompare(b.code)).map(a => {
    const rows = je.filter(j => j.account_id === a.id), d = sum(rows, 'debit'), c = sum(rows, 'credit');
    return { code: a.code, name: a.name, type: a.type, debit: r2(Math.max(0, d - c)), credit: r2(Math.max(0, c - d)) };
  });
}
