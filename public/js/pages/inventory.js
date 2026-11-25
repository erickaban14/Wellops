// Inventory transactions: receiving, QA, issue / return / adjustment, physical inventory.
import { actionBtn, api, badge, can, cap, card, confirmBox, field, fmtDate, fmtDT, fmtMoney, fmtNum, h, invalidate, names, page, rows, segmented, select, simpleTable, state, toast, valueHelp } from '../core.js';

const qty = (v = '', attrs = {}) => h('input', { type: 'number', step: 'any', min: 0, value: v, style: { maxWidth: '120px' }, ...attrs });

export async function receivePage(root, id, base) {
  const [pos, sup, item, moves] = await Promise.all([rows('purchase_orders'), names('suppliers'), names('items'), rows('stock_moves')]);
  if (!id) {
    return root.replaceChildren(...page('Receive incoming materials', null, card('Approved purchase orders awaiting receipt', null, simpleTable(
      [{ label: 'PO', key: 'po_no' }, { label: 'Supplier', get: p => sup[p.supplier_id] }, { label: 'Expected', get: p => fmtDate(p.expected_date) }, { label: 'Total', get: p => fmtNum(p.total), num: 1 }, { label: 'Status', get: p => badge(p.status) }],
      pos.filter(p => ['approved', 'partially received'].includes(p.status)), { onRow: p => { location.hash = `${base}/${p.id}`; }, empty: 'No approved purchase orders are waiting. POs appear here once fully approved.' }))));
  }
  const po = pos.find(p => p.id === id);
  if (!po) throw new Error('Purchase order not found');
  const lines = (po.lines || []).filter(l => l.item_id).map(l => {
    const got = moves.filter(m => m.po_id === id && m.move_type === 'receipt' && m.item_id === l.item_id).reduce((a, m) => a + Number(m.qty), 0);
    return { ...l, got, input: qty(Math.max(0, l.qty - got)) };
  });
  root.replaceChildren(...page([h('a', { href: base }, 'Receive'), h('span.sep', '/'), po.po_no], can('inventory') ? actionBtn('Post receipt', async () => {
    await api('/inventory/receive', { body: { po_id: id, lines: lines.map(l => ({ item_id: l.item_id, qty: l.input.value })) } });
    invalidate(); toast('Receipt posted. Items that require QA are in quarantine until inspected.', 'good'); location.hash = base;
  }, 'primary') : null, card(`${sup[po.supplier_id]} · ${po.status}`, null, simpleTable([{ label: 'Item', get: l => item[l.item_id] }, { label: 'Ordered', get: l => fmtNum(l.qty), num: 1 },
    { label: 'Already received', get: l => fmtNum(l.got), num: 1 }, { label: 'Receive now', get: l => l.input }], lines))));
}

export async function qaPage(root) {
  const [moves, item] = await Promise.all([rows('stock_moves'), names('items')]);
  const list = moves.filter(m => m.qa_status === 'pending').map(m => ({ ...m, ok: qty(m.qty, { max: m.qty }), note: h('input', { placeholder: 'Findings / remarks' }) }));
  const inspect = m => actionBtn('Record result', async () => {
    const r = await api('/inventory/qa', { body: { move_id: m.id, qty_accepted: m.ok.value, remarks: m.note.value } });
    invalidate(); toast(`QA ${r.qa_status}: accepted quantity is now in stock`, 'good'); qaPage(root);
  }, 'primary small');
  root.replaceChildren(...page('Quality inspection', h('a.btn', { href: '#/inventory/qa_inspections' }, 'QA history'),
    h('div.banner', 'Received items flagged "QA required" stay out of available stock until inspected. Rejected quantities are returned to the supplier.'),
    card('Awaiting inspection', null, simpleTable([{ label: 'Receipt', get: m => `${m.ref} · ${fmtDT(m.move_date)}` }, { label: 'Item', get: m => item[m.item_id] }, { label: 'Received', get: m => fmtNum(m.qty), num: 1 },
      { label: 'Accepted qty', get: m => m.ok }, { label: 'Remarks', get: m => m.note }, { label: '', get: inspect }], list, { empty: 'Nothing is waiting for QA' }))));
}

export async function transactionsPage(root) {
  const [items, projects] = await Promise.all([rows('items'), rows('projects')]);
  const TYPES = { issue: ['Issue to project', '/inventory/issue'], 'from project': ['Return from project', '/inventory/return'], 'to supplier': ['Return to supplier', '/inventory/return'], adjust: ['Stock adjustment (+/-)', '/inventory/adjust'] };
  const SIGN = { issue: -1, 'from project': 1, 'to supplier': -1, adjust: 1 };
  const type = segmented(Object.entries(TYPES).map(([k, v]) => [k, v[0].replace(' (+/-)', '')]), 'issue', { label: 'Transaction' });
  const item = valueHelp('items', '', { label: 'Item' });
  const proj = valueHelp('projects', '', { label: 'Project', filter: p => p.status !== 'completed' });
  const q = h('input.num', { type: 'number', step: 'any', inputMode: 'decimal', placeholder: '0' }), note = h('input', { placeholder: 'Reason / reference' });
  const projField = field('Project', proj), preview = h('section.card.sidecard', { 'aria-live': 'polite' });
  const sync = () => {
    const it = items.find(i => i.id === item.value), k = type.value || 'issue', n = Number(q.value) || 0;
    projField.hidden = ['to supplier', 'adjust'].includes(k);
    q.min = k === 'adjust' ? '' : 0;
    if (!it) return preview.replaceChildren(h('header', h('h2', 'Stock preview')), h('div.body.muted', 'Choose an item to see its stock before and after this transaction.'));
    const before = Number(it.on_hand) || 0, after = before + SIGN[k] * n, uom = it.uom || '';
    const warn = after < 0 ? ['Not enough stock for this quantity', 'bad'] : after <= (Number(it.safety_stock) || 0) && n ? ['Goes below safety stock', 'bad'] : after <= (Number(it.reorder_level) || 0) && n ? ['Goes below the reorder level', 'warn'] : null;
    preview.replaceChildren(h('header', h('h2', 'Stock preview')), h('div.body',
      h('div.beforeafter', h('div', h('span', 'Before'), h('strong.num', `${fmtNum(before)} ${uom}`)), h('div.arrow', '→'),
        h('div', { class: warn?.[1] || '' }, h('span', 'After'), h('strong.num', `${fmtNum(after)} ${uom}`))),
      warn ? h('div.banner', { class: warn[1] }, warn[0]) : null,
      stockGauge({ ...it, on_hand: after }),
      h('dl.kv', [h('dt', 'Value of this move'), h('dd.num', fmtMoney(n * (Number(it.unit_cost) || 0)))], [h('dt', 'Bin'), h('dd', it.location || '—')])));
  };
  [type, item, q].forEach(el => el.addEventListener(el === q ? 'input' : 'change', sync));
  const post = async () => {
    if (!item.value) throw new Error('Choose an item');
    if (!(Number(q.value) || 0)) throw new Error('Enter a quantity');
    await api(TYPES[type.value][1], { body: { item_id: item.value, qty: q.value, project_id: proj.value || null, kind: type.value, remarks: note.value } });
    invalidate(); toast(`${TYPES[type.value][0]} posted`, 'good'); transactionsPage(root);
  };
  root.replaceChildren(...page('Issue / Return / Adjust', h('a.btn', { href: '#/inventory/stock_moves' }, 'Stock moves'), can('inventory') ? h('div.objgrid.with-side',
    card('New transaction', actionBtn('Post transaction', post, 'primary'), h('div.body', h('div.fields.single', field('Transaction', type, 'wide'), field('Item', item, 'wide'), field('Quantity', q), projField, field('Remarks', note, 'wide')),
      h('p.hint', 'Issues charge the material cost to the project; returns from a project credit it back. Adjustments need a reason and post to the inventory adjustment account.'))),
    h('aside.objside', preview))
    : h('div.banner.warn', 'Your role cannot post inventory transactions.')));
  sync();
}

export async function countsPage(root, id, base) {
  const counts = (await rows('stock_counts')).slice().reverse();
  if (!id) {
    const cat = select([['', 'All categories'], 'supply', 'material', 'tool', 'machine', 'spare part']);
    return root.replaceChildren(...page('Physical Inventory', can('inventory') ? [cat, actionBtn('Start count', async () => { const c = await api('/inventory/counts/start', { body: { category: cat.value } }); invalidate(); location.hash = `${base}/${c.id}`; }, 'primary')] : null,
      card(null, null, simpleTable([{ label: 'Count', key: 'count_no' }, { label: 'Date', get: c => fmtDate(c.count_date) }, { label: 'Items', get: c => (c.lines || []).length, num: 1 },
        { label: 'Variances', get: c => (c.status === 'posted' ? (c.lines || []).filter(l => l.variance).length : ''), num: 1 }, { label: 'Status', get: c => badge(c.status) }],
      counts, { onRow: c => { location.hash = `${base}/${c.id}`; }, empty: 'No physical inventory counts yet' }))));
  }
  const c = counts.find(x => x.id === id);
  if (!c) throw new Error('Count not found');
  const open = c.status === 'draft' && can('inventory');
  const lines = c.lines.map(l => ({ ...l, input: h('input', { type: 'number', step: 'any', min: 0, value: l.counted_qty ?? '', disabled: !open, style: { maxWidth: '120px' }, 'aria-label': `Counted quantity for ${l.name}` }) }));
  const collect = () => lines.map(({ input, ...l }) => ({ ...l, counted_qty: input.value === '' ? null : Number(input.value) }));
  const save = async () => { await api(`/inventory/counts/${id}`, { method: 'PUT', body: { lines: collect() } }); invalidate(); };
  root.replaceChildren(...page([h('a', { href: base }, 'Physical Inventory'), h('span.sep', '/'), c.count_no], [badge(c.status), open ? [actionBtn('Save counts', async () => { await save(); toast('Counts saved', 'good'); }),
    h('button.btn.primary', { onclick: async () => { await save(); confirmBox('Post this count? Stock on hand is set to the counted quantities and variances are booked as adjustments. Lines left blank are not changed.', 'Post count',
      async () => { const r = await api(`/inventory/counts/${id}/post`, { body: {} }); invalidate(); toast(`Count posted: ${r.adjusted} adjustment(s)`, 'good'); countsPage(root, id, base); }); } }, 'Post adjustments')] : null],
  card('Count sheet', h('button.btn.small', { onclick: () => window.print() }, 'Print'), simpleTable([{ label: 'Item', get: l => `${l.code} · ${l.name}` }, { label: 'Bin', key: 'location' }, { label: 'System qty', get: l => `${fmtNum(l.system_qty)} ${l.uom || ''}`, num: 1 },
    { label: 'Counted', get: l => l.input }, { label: 'Variance', get: l => (l.variance ? badge(`${l.variance > 0 ? '+' : ''}${fmtNum(l.variance)}`, l.variance > 0 ? 'info' : 'bad') : c.status === 'posted' && l.counted_qty != null ? badge('match', 'good') : '') }], lines))));
}

// ---- Item master: live stock position (side panel) and movement history (tab) ----
const MOVE_SIGN = { receipt: 1, 'return in': 1, issue: -1, 'return out': -1, adjustment: 1 };
export function stockGauge(it) {
  const on = Number(it.on_hand) || 0, reorder = Number(it.reorder_level) || 0, safety = Number(it.safety_stock) || 0;
  const max = Math.max(on, reorder * 2, safety * 2, 1), pct = v => `${Math.min(100, (v / max) * 100)}%`;
  const state = on <= 0 ? ['Out of stock', 'bad'] : on <= safety ? ['Below safety stock', 'bad'] : on <= reorder ? ['Reorder now', 'warn'] : ['Stock OK', 'good'];
  return h('div.gauge', h('div.g-head', h('strong.num', `${fmtNum(on)} ${it.uom || ''}`), badge(state[0], state[1])),
    h('div.g-track', { role: 'img', 'aria-label': `On hand ${on}, reorder level ${reorder}, safety stock ${safety}` },
      h('i', { class: state[1], style: { width: pct(on) } }), reorder ? h('b', { title: `Reorder level ${reorder}`, style: { left: pct(reorder) } }) : null, safety ? h('b.safe', { title: `Safety stock ${safety}`, style: { left: pct(safety) } }) : null),
    h('div.g-legend', reorder ? h('span', h('b'), `Reorder ${fmtNum(reorder)}`) : null, safety ? h('span', h('b.safe'), `Safety ${fmtNum(safety)}`) : null));
}
export async function itemSide(it, { isNew, rec }) {
  const [moves, sup] = await Promise.all([isNew ? [] : rows('stock_moves'), names('suppliers')]);
  const mine = moves.filter(m => m.item_id === rec.id).slice(-5).reverse();
  const value = (Number(it.on_hand) || 0) * (Number(it.unit_cost) || 0);
  return [
    h('section.card.sidecard', h('header', h('h2', 'Stock position')), h('div.body', stockGauge(it),
      h('dl.kv', [h('dt', 'Stock value'), h('dd.num', fmtMoney(value))], [h('dt', 'Bin'), h('dd', it.location || '—')],
        [h('dt', 'Lead time'), h('dd', it.lead_time_days ? `${it.lead_time_days} days` : '—')], [h('dt', 'Supplier'), h('dd', sup[it.preferred_supplier_id] || '—')],
        [h('dt', 'QA on receipt'), h('dd', it.qa_required ? 'Required' : 'No')]))),
    isNew ? null : h('section.card.sidecard', h('header', h('h2', 'Recent movements')), mine.length ? h('ul.moves', mine.map(m =>
      h('li', h('span', h('strong', cap(m.move_type)), h('small', `${fmtDT(m.move_date)}${m.ref ? ` · ${m.ref}` : ''}`)),
        h('span.num', { class: (MOVE_SIGN[m.move_type] || 1) * Math.sign(m.qty) < 0 ? 'neg' : 'pos' }, `${(MOVE_SIGN[m.move_type] || 1) * Math.sign(m.qty) < 0 ? '−' : '+'}${fmtNum(Math.abs(m.qty))}`))))
      : h('div.body.muted', 'No movements yet.')),
  ];
}
export async function itemHistory(it) {
  const [moves, proj] = await Promise.all([rows('stock_moves'), names('projects')]);
  const mine = moves.filter(m => m.item_id === it.id).reverse();
  return simpleTable([{ label: 'Date', get: m => fmtDT(m.move_date) }, { label: 'Type', get: m => cap(m.move_type) }, { label: 'Qty', get: m => fmtNum(m.qty), num: 1 },
    { label: `Unit cost (${state.symbol})`, get: m => fmtNum(m.unit_cost, 3), num: 1 }, { label: 'Project', get: m => proj[m.project_id] || '' }, { label: 'Ref', key: 'ref' }, { label: 'QA', get: m => (m.qa_status && m.qa_status !== 'n/a' ? badge(m.qa_status) : '') }],
  mine, { empty: 'No stock movements for this item yet.' });
}
export const itemFigures = it => [['On hand', `${fmtNum(it.on_hand || 0)} ${it.uom || ''}`], ['Unit cost', fmtMoney(it.unit_cost || 0)], ['Stock value', fmtMoney((Number(it.on_hand) || 0) * (Number(it.unit_cost) || 0))]];
