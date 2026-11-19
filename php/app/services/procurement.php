<?php
// Procurement: RFQs from a firmed MRP run, RFQ -> PO, PO approval routing (port of server/services/procurement.js).

/** One RFQ per preferred supplier from the open requisitions of an approved and firmed MRP run. */
function proc_generate_rfqs($runId): array
{
    $run = ($runId ? Db::get('mrp_runs', (string) $runId) : null) ?? fail(404, 'MRP run not found');
    if ($run['status'] !== 'firmed') fail(400, 'RFQs are generated from an approved and firmed MRP run');
    $reqs = Db::list('requisitions', ['mrp_run_id' => $runId, 'status' => 'open']);
    $I = by_id(Db::list('items'));
    $groups = [];
    foreach ($reqs as $r) $groups['s:' . ($I[$r['item_id'] ?? '']['preferred_supplier_id'] ?? '')][] = $r;
    $created = 0;
    foreach ($groups as $key => $rows) {
        $supplier = substr($key, 2);
        $dates = array_values(array_filter(array_map(fn($r) => $r['order_by'] ?? null, $rows)));
        sort($dates);
        Db::insert('rfqs', ['rfq_no' => Db::nextNo('rfqs', 'rfq_no', 'RFQ-'), 'supplier_id' => $supplier ?: null, 'rfq_date' => today(),
            'due_date' => $dates[0] ?? add_days(today(), 7), 'status' => 'draft', 'mrp_run_id' => $runId,
            'lines' => array_map(fn($r) => ['item_id' => $r['item_id'], 'description' => $r['description'] ?? null, 'qty' => num($r['qty'] ?? 0),
                'price' => num($I[$r['item_id'] ?? '']['unit_cost'] ?? 0), 'need_date' => $r['need_date'] ?? null, 'requisition_id' => $r['id']], $rows)]);
        foreach ($rows as $r) Db::update('requisitions', $r['id'], ['status' => 'rfq']);
        $created++;
    }
    return ['created' => $created];
}

function proc_rfq_to_po(string $id): array
{
    $rfq = Db::get('rfqs', $id) ?? fail(404, 'RFQ not found');
    if ($rfq['status'] === 'converted') fail(400, 'RFQ already converted');
    if (empty($rfq['supplier_id'])) fail(400, 'Select a supplier on the RFQ first');
    $rl = $rfq['lines'] ?? [];
    $lines = array_map(fn($l) => ['item_id' => $l['item_id'] ?? null, 'description' => $l['description'] ?? null, 'qty' => num($l['qty'] ?? 0), 'price' => num($l['price'] ?? 0)], $rl);
    $dates = array_values(array_filter(array_map(fn($l) => $l['need_date'] ?? null, $rl)));
    sort($dates);
    $po = Db::insert('purchase_orders', ['po_no' => Db::nextNo('purchase_orders', 'po_no', 'PO-'), 'supplier_id' => $rfq['supplier_id'], 'order_date' => today(),
        'expected_date' => $dates[0] ?? null, 'rfq_id' => $id, 'lines' => $lines, 'total' => po_total($lines), 'status' => 'draft', 'approvals' => []]);
    Db::update('rfqs', $id, ['status' => 'converted']);
    foreach ($rl as $l) {
        if (empty($l['requisition_id'])) continue;
        try { Db::update('requisitions', $l['requisition_id'], ['status' => 'ordered']); } catch (HttpError $e) { /* requisition no longer exists */ }
    }
    return $po;
}

/** Approval routing: every rule whose threshold is reached adds an approver, in sequence. */
function proc_submit_po(string $id): array
{
    $po = Db::get('purchase_orders', $id) ?? fail(404, 'PO not found');
    if (!in_array($po['status'], ['draft', 'rejected'], true)) fail(400, 'PO is ' . $po['status']);
    $total = po_total($po['lines'] ?? []);
    if (!$total) fail(400, 'Add at least one line with quantity and price');
    $chain = array_values(array_filter(Db::list('approval_rules'), fn($r) => $total >= num($r['min_amount'] ?? 0)));
    usort($chain, fn($a, $b) => num($a['seq'] ?? 0) <=> num($b['seq'] ?? 0));
    if (!$chain) return Db::update('purchase_orders', $id, ['total' => $total, 'status' => 'approved', 'current_approver' => '', 'approvals' => []]);
    notify($chain[0]['role'], "PO {$po['po_no']} needs your approval", 'Total ' . fmt_num($total), ['kind' => 'approval', 'ref_table' => 'purchase_orders', 'ref_id' => $id]);
    return Db::update('purchase_orders', $id, ['total' => $total, 'status' => 'pending approval', 'current_approver' => $chain[0]['role'],
        'approvals' => array_map(fn($r) => ['role' => $r['role'], 'status' => 'pending'], $chain)]);
}

function proc_decide_po(string $id, bool $approve, $note, array $user): array
{
    $po = Db::get('purchase_orders', $id) ?? fail(404, 'PO not found');
    if ($po['status'] !== 'pending approval') fail(400, 'PO is not awaiting approval');
    if ($user['role'] !== ($po['current_approver'] ?? '') && $user['role'] !== 'admin') fail(403, 'This PO is waiting for: ' . $po['current_approver']);
    if (!$approve && trim((string) $note) === '') fail(400, 'A reason is required when rejecting');
    $approvals = $po['approvals'] ?? [];
    $step = null;
    foreach ($approvals as $i => $a) if (($a['status'] ?? '') === 'pending') { $step = $i; break; }
    if ($step === null) fail(400, 'PO has no pending approval step');
    $approvals[$step] = array_merge($approvals[$step], ['status' => $approve ? 'approved' : 'rejected', 'by' => $user['name'], 'at' => now_iso(), 'note' => $note ?: '']);
    if (!$approve) return Db::update('purchase_orders', $id, ['status' => 'rejected', 'current_approver' => '', 'approvals' => $approvals]);
    $next = null;
    foreach ($approvals as $a) if (($a['status'] ?? '') === 'pending') { $next = $a; break; }
    if ($next) {
        notify($next['role'], "PO {$po['po_no']} needs your approval", 'Total ' . fmt_num($po['total'] ?? 0) . ' - approved by ' . $user['name'], ['kind' => 'approval', 'ref_table' => 'purchase_orders', 'ref_id' => $id]);
        return Db::update('purchase_orders', $id, ['current_approver' => $next['role'], 'approvals' => $approvals]);
    }
    notify('buyer', "PO {$po['po_no']} fully approved", 'Ready to send to supplier and receive.');
    return Db::update('purchase_orders', $id, ['status' => 'approved', 'current_approver' => '', 'approvals' => $approvals]);
}

function routes_procurement(callable $route): void
{
    $route('POST', 'procurement/rfq/generate', act(['procurement', 'planning'], fn($p, $b) => proc_generate_rfqs($b['run_id'] ?? null)));
    $route('POST', 'procurement/rfq/{id}/convert', act(['procurement'], fn($p) => proc_rfq_to_po($p['id'])));
    $route('POST', 'procurement/po/{id}/submit', act(['procurement'], fn($p) => proc_submit_po($p['id'])));
    $route('POST', 'procurement/po/{id}/decide', act([], fn($p, $b, $u) => proc_decide_po($p['id'], !empty($b['approve']), $b['note'] ?? '', $u)));
}
