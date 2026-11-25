// Sales order side panel: who the customer is, their open business, and what this order will release to Planning.
import { badge, cap, fmtDate, fmtMoney, h, rows } from '../core.js';

const OP_ICON = { drilling: '⛏', workover: '🔧', 'surface pumping': '⛽' };
const days = d => Math.round((new Date(`${d}T00:00:00Z`) - new Date(new Date().toISOString().slice(0, 10))) / 864e5);

export async function salesOrderSide(so, { vh }) {
  const [orders, wells] = await Promise.all([rows('sales_orders'), rows('wells')]);
  const cust = vh.customer_id?.record(), well = vh.well_id?.record();
  const theirs = cust ? orders.filter(o => o.customer_id === cust.id && o.id !== so.id && !['done', 'cancelled'].includes(o.status)) : [];
  const start = so.requested_start, until = start ? days(start) : null;
  return [
    h('section.card.sidecard', h('header', h('h2', 'Customer')), cust ? h('div.body',
      h('div.big', cust.name),
      h('dl.kv', cust.contact_person ? [h('dt', 'Contact'), h('dd', cust.contact_person)] : null,
        cust.phone ? [h('dt', 'Phone'), h('dd', h('a', { href: `tel:${cust.phone}` }, cust.phone))] : null,
        cust.email ? [h('dt', 'Email'), h('dd', h('a', { href: `mailto:${cust.email}` }, cust.email))] : null,
        [h('dt', 'Wells'), h('dd', String(wells.filter(w => w.customer_id === cust.id).length))],
        [h('dt', 'Open orders'), h('dd', `${theirs.length} · ${fmtMoney(theirs.reduce((a, o) => a + (Number(o.amount) || 0), 0))}`)]))
      : h('div.body.muted', 'Choose a customer to see their contact details and open business.')),
    h('section.card.sidecard', h('header', h('h2', 'Order summary')), h('div.body',
      h('div.big.num', so.amount !== '' && so.amount != null ? fmtMoney(so.amount) : '—'),
      h('dl.kv',
        [h('dt', 'Operation'), h('dd', so.operation ? `${OP_ICON[so.operation] || ''} ${cap(so.operation)}` : '—')],
        [h('dt', 'Well'), h('dd', well ? `${well.name}${well.field ? ` · ${well.field}` : ''}` : '—')],
        [h('dt', 'Target'), h('dd', [so.target_depth_ft && `${Number(so.target_depth_ft).toLocaleString()} ft`, so.target_flow_gpm && `${so.target_flow_gpm} gpm`].filter(Boolean).join(' · ') || '—')],
        [h('dt', 'Start'), h('dd', start ? [fmtDate(start), ' ', badge(until < 0 ? `${-until} days ago` : until === 0 ? 'today' : `in ${until} days`, until < 7 ? 'warn' : 'info')] : '—')],
        [h('dt', 'Status'), h('dd', badge(so.status || 'quotation'))]),
      so.status === 'quotation' ? h('p.hint', 'Confirm the order to release it to Planning (Master Schedule).') : null)),
  ];
}
