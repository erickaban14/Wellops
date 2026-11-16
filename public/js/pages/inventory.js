// Inventory transactions: receiving, QA, issue / return / adjustment, physical inventory.
import { actionBtn, api, badge, can, card, confirmBox, field, fmtDate, fmtDT, fmtNum, h, invalidate, names, page, rows, select, simpleTable, toast } from '../core.js';

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
  const type = select(Object.entries(TYPES).map(([k, v]) => [k, v[0]]), 'issue');
  const item = select([['', ''], ...items.map(i => [i.id, `${i.code} · ${i.name}`])]), proj = select([['', ''], ...projects.filter(p => p.status !== 'completed').map(p => [p.id, `${p.code} · ${p.name}`])]);
  const q = h('input', { type: 'number', step: 'any' }), note = h('input', { placeholder: 'Reason / reference' }), onHand = h('div.muted');
  const projField = field('Project', proj);
  const sync = () => {
    const it = items.find(i => i.id === item.value);
    onHand.textContent = it ? `On hand: ${fmtNum(it.on_hand)} ${it.uom || ''} · bin ${it.location || '-'}` : '';
    projField.hidden = ['to supplier', 'adjust'].includes(type.value);
    q.min = type.value === 'adjust' ? '' : 0;
  };
  type.onchange = item.onchange = sync;
  root.replaceChildren(...page('Issue / Return / Adjust', h('a.btn', { href: '#/inventory/stock_moves' }, 'Stock moves'), can('inventory') ? card('New transaction', actionBtn('Post transaction', async () => {
    if (!item.value) throw new Error('Select an item');
    await api(TYPES[type.value][1], { body: { item_id: item.value, qty: q.value, project_id: proj.value || null, kind: type.value, remarks: note.value } });
    invalidate(); toast(`${TYPES[type.value][0]} posted`, 'good'); transactionsPage(root);
  }, 'primary'), h('div.body', h('div.fields', field('Transaction', type), field('Item', h('div', item, onHand)), field('Quantity', q), projField, field('Remarks', note, 'wide')),
    h('p.muted', 'Issues charge the material cost to the project; returns from a project credit it back. Adjustments require a reason and post to the inventory adjustment account.')))
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
