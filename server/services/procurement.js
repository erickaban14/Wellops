// Procurement: RFQs from firmed MRP, RFQ -> PO, PO approval routing.
import { db } from '../store/index.js';
import { addDays, byId, fail, groupBy, num, r2, sum, today } from '../util.js';
import { notify } from './common.js';

// 4.5 Generate RFQs (one per preferred supplier) from the requisitions of an approved and firmed MRP run.
export async function generateRfqs(runId) {
  const run = await db.get('mrp_runs', runId) || fail(404, 'MRP run not found');
  if (run.status !== 'firmed') fail(400, 'RFQs are generated from an approved and firmed MRP run');
  const [reqs, items] = await Promise.all([db.list('requisitions', { mrp_run_id: runId, status: 'open' }), db.list('items')]);
  const I = byId(items);
  const groups = groupBy(reqs, r => I[r.item_id]?.preferred_supplier_id || '');
  let created = 0;
  for (const [supplier, rows] of Object.entries(groups)) {
    await db.insert('rfqs', { rfq_no: await db.nextNo('rfqs', 'rfq_no', 'RFQ-'), supplier_id: supplier || null, rfq_date: today(), due_date: rows.map(r => r.order_by).filter(Boolean).sort()[0] || addDays(today(), 7),
      status: 'draft', mrp_run_id: runId, lines: rows.map(r => ({ item_id: r.item_id, description: r.description, qty: num(r.qty), price: num(I[r.item_id]?.unit_cost), need_date: r.need_date, requisition_id: r.id })) });
    for (const r of rows) await db.update('requisitions', r.id, { status: 'rfq' });
    created++;
  }
  return { created };
}

export async function rfqToPo(id) {
  const rfq = await db.get('rfqs', id) || fail(404, 'RFQ not found');
  if (rfq.status === 'converted') fail(400, 'RFQ already converted');
  if (!rfq.supplier_id) fail(400, 'Select a supplier on the RFQ first');
  const lines = (rfq.lines || []).map(l => ({ item_id: l.item_id, description: l.description, qty: num(l.qty), price: num(l.price) }));
  const po = await db.insert('purchase_orders', { po_no: await db.nextNo('purchase_orders', 'po_no', 'PO-'), supplier_id: rfq.supplier_id, order_date: today(),
    expected_date: (rfq.lines || []).map(l => l.need_date).filter(Boolean).sort()[0] || null, rfq_id: id, lines, total: poTotal(lines), status: 'draft', approvals: [] });
  await db.update('rfqs', id, { status: 'converted' });
  for (const l of rfq.lines || []) if (l.requisition_id) await db.update('requisitions', l.requisition_id, { status: 'ordered' }).catch(() => {});
  return po;
}

export const poTotal = lines => r2(sum(lines || [], l => num(l.qty) * num(l.price)));

// 4.5.2 Approval routing: every rule whose threshold is reached adds an approver, in sequence.
export async function submitPo(id) {
  const po = await db.get('purchase_orders', id) || fail(404, 'PO not found');
  if (!['draft', 'rejected'].includes(po.status)) fail(400, `PO is ${po.status}`);
  const total = poTotal(po.lines);
  if (!total) fail(400, 'Add at least one line with quantity and price');
  const chain = (await db.list('approval_rules')).filter(r => total >= num(r.min_amount)).sort((a, b) => a.seq - b.seq);
  if (!chain.length) return db.update('purchase_orders', id, { total, status: 'approved', current_approver: '', approvals: [] });
  await notify(chain[0].role, `PO ${po.po_no} needs your approval`, `Total ${total.toLocaleString()}`, { kind: 'approval', ref_table: 'purchase_orders', ref_id: id });
  return db.update('purchase_orders', id, { total, status: 'pending approval', current_approver: chain[0].role, approvals: chain.map(r => ({ role: r.role, status: 'pending' })) });
}

export async function decidePo(id, approve, note, user) {
  const po = await db.get('purchase_orders', id) || fail(404, 'PO not found');
  if (po.status !== 'pending approval') fail(400, 'PO is not awaiting approval');
  if (user.role !== po.current_approver && user.role !== 'admin') fail(403, `This PO is waiting for: ${po.current_approver}`);
  if (!approve && !String(note || '').trim()) fail(400, 'A reason is required when rejecting');
  const approvals = po.approvals || [];
  const step = approvals.find(a => a.status === 'pending');
  Object.assign(step, { status: approve ? 'approved' : 'rejected', by: user.name, at: new Date().toISOString(), note: note || '' });
  const next = approvals.find(a => a.status === 'pending');
  if (!approve) return db.update('purchase_orders', id, { status: 'rejected', current_approver: '', approvals });
  if (next) {
    await notify(next.role, `PO ${po.po_no} needs your approval`, `Total ${num(po.total).toLocaleString()} - approved by ${user.name}`, { kind: 'approval', ref_table: 'purchase_orders', ref_id: id });
    return db.update('purchase_orders', id, { current_approver: next.role, approvals });
  }
  await notify('buyer', `PO ${po.po_no} fully approved`, 'Ready to send to supplier and receive.');
  return db.update('purchase_orders', id, { status: 'approved', current_approver: '', approvals });
}
