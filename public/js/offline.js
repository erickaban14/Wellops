// Offline support for Daily Work Tickets: tickets entered without a connection are queued on the device
// and pushed to the server automatically when the connection returns.
import { api, state, toast } from './core.js';

const QUEUE = 'wo_dwt_queue', REF = 'wo_dwt_ref';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

export const queued = () => read(QUEUE, []);
export function enqueue(ticket) {
  const q = queued().filter(t => t.client_id !== ticket.client_id);
  q.push({ ...ticket, entry_mode: 'offline', queued_at: new Date().toISOString() });
  localStorage.setItem(QUEUE, JSON.stringify(q));
  state.onNet?.();
}
export const dequeue = clientId => { localStorage.setItem(QUEUE, JSON.stringify(queued().filter(t => t.client_id !== clientId))); state.onNet?.(); };
export const saveRef = ref => localStorage.setItem(REF, JSON.stringify({ ...ref, saved_at: new Date().toISOString() }));
export const loadRef = () => read(REF, null);

let busy = false;
export async function flushQueue(manual) {
  const q = queued();
  if (!q.length) { if (manual) toast(state.offline ? 'You are offline' : 'Nothing waiting to sync'); return; }
  if (busy) return;
  busy = true;
  try {
    const { results } = await api('/operations/tickets/sync', { body: { tickets: q } });
    const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
    localStorage.setItem(QUEUE, JSON.stringify(queued().filter(t => !ok.some(r => r.client_id === t.client_id))));
    if (ok.length) toast(`${ok.length} offline work ticket(s) synchronised: ${ok.map(r => r.ticket_no).join(', ')}`, 'good');
    if (bad.length) toast(`Could not sync ${bad.length} ticket(s): ${bad[0].error}`, 'bad');
  } catch (e) { if (manual) toast(e.offline ? 'Still offline - tickets stay safely on this device' : e.message, 'bad'); }
  busy = false;
  state.onNet?.();
}

let started = false;
export function initOffline(onChange) {
  state.onNet = onChange;
  if (started) return;
  started = true;
  window.addEventListener('online', () => setTimeout(flushQueue, 800));
  setInterval(() => queued().length && flushQueue(), 30000);
  flushQueue();
}
