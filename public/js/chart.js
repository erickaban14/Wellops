// Small SVG charts: a two-series trend line with legend, direct labels, hover crosshair and a table view; and a sparkline.
// Series colours are the validated categorical pair (--s1 blue = plan, --s2 orange = actual) in both themes.
import { h } from './core.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = v => { const p = 10 ** Math.floor(Math.log10(v || 1)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

export function lineChart({ labels, series, fmt = v => String(v), max, title }) {
  const W = 640, H = 230, m = { l: 48, r: 96, t: 12, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const top = max || nice(Math.max(1, ...series.flatMap(s => s.values)));
  const x = i => m.l + (labels.length > 1 ? i / (labels.length - 1) * iw : iw / 2), y = v => m.t + ih - v / top * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * top);
  const last = labels.length - 1;
  // direct labels at the line ends, nudged apart if they would collide
  const ends = series.map(s => y(s.values[last]));
  if (series.length === 2 && Math.abs(ends[0] - ends[1]) < 15) { const mid = (ends[0] + ends[1]) / 2, up = ends[0] <= ends[1] ? 0 : 1; ends[up] = mid - 8; ends[1 - up] = mid + 8; }
  const xl = [...new Set([0, Math.round(last / 2), last])];
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${ticks.map(t => `<line class="gridline" x1="${m.l}" x2="${m.l + iw}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`).join('')}
    ${xl.map(i => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === last && last ? 'end' : 'middle'}">${esc(labels[i])}</text>`).join('')}
    ${series.map(s => `<polyline fill="none" stroke="var(${s.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`).join('')}
    ${series.map((s, k) => `<circle cx="${x(last)}" cy="${y(s.values[last])}" r="4.5" fill="var(${s.color})" stroke="var(--card)" stroke-width="2"/>
      <text x="${x(last) + 10}" y="${ends[k] + 4}"><tspan style="fill:var(--ink);font-weight:600">${esc(fmt(s.values[last]))}</tspan> ${esc(s.name)}</text>`).join('')}
    <line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
    ${series.map(s => `<circle class="hov" r="4.5" fill="var(${s.color})" stroke="var(--card)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  const tip = h('div.tip', { hidden: true });
  const box = h('div.chart', { innerHTML: svg }, tip);
  const el = box.querySelector('svg'), cross = el.querySelector('.cross'), dots = [...el.querySelectorAll('.hov')];
  const show = i => {
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    dots.forEach((d, k) => { d.setAttribute('cx', x(i)); d.setAttribute('cy', y(series[k].values[i])); d.setAttribute('visibility', 'visible'); });
    tip.replaceChildren(h('strong', labels[i]), ...series.map(s => h('div', h('i', { style: { display: 'inline-block', width: '10px', height: '3px', background: `var(${s.color})`, marginRight: '6px', verticalAlign: 'middle' } }), `${s.name}: `, h('strong', fmt(s.values[i])))));
    tip.hidden = false;
    const px = x(i) / W * box.clientWidth;
    tip.style.left = `${Math.min(Math.max(4, px + 12), box.clientWidth - tip.offsetWidth - 4)}px`; tip.style.top = '8px';
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); };
  el.querySelector('.hit').addEventListener('pointermove', e => { const r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W; show(Math.max(0, Math.min(last, Math.round((px - m.l) / iw * last)))); });
  el.querySelector('.hit').addEventListener('pointerleave', hide);
  return h('div', h('div.legend', { style: { marginBottom: '6px' } }, series.map(s => h('span', h('i', { style: { background: `var(${s.color})` } }), s.name))), box,
    h('details', { style: { marginTop: '8px' } }, h('summary.muted', { style: { cursor: 'pointer', fontSize: '12.5px' } }, 'View as table'),
      h('div.table-wrap', h('table', h('thead', h('tr', h('th', { scope: 'col' }, 'Date'), series.map(s => h('th.num', { scope: 'col' }, s.name)))),
        h('tbody', labels.map((l, i) => h('tr', h('td', l), series.map(s => h('td.num', fmt(s.values[i]))))))))));
}

// Tiny two-line trend for dashboard rows (plan vs actual). Decorative: the numbers sit beside it.
export function sparkline(pairs) {
  if (!pairs || pairs.length < 2) return h('span');
  const W = 96, H = 30, top = Math.max(1, ...pairs.flat()), x = i => 2 + i / (pairs.length - 1) * (W - 4), y = v => H - 3 - v / top * (H - 6);
  const line = (k, c) => `<polyline fill="none" stroke="var(${c})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pairs.map((p, i) => `${x(i)},${y(p[k])}`).join(' ')}"/>`;
  return h('span', { 'aria-hidden': 'true', title: 'Progress trend: plan (blue) vs actual (orange)', innerHTML: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${line(0, '--s1')}${line(1, '--s2')}</svg>` });
}
