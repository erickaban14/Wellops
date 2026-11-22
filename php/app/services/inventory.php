<?php
// Inventory (receiving, QA, issues, returns, adjustments, physical counts) and light finance postings.
// Port of server/services/inventory.js.

function inv_item($id): array { return ($id ? Db::get('items', (string) $id) : null) ?? fail(400, 'Item not found'); }
function inv_bump(array $it, $delta): array { return Db::update('items', $it['id'], ['on_hand' => r2(num($it['on_hand'] ?? 0) + $delta)]); }
function inv_move(array $row, array $user): array
{
    return Db::insert('stock_moves', array_merge(['move_date' => now_iso(), 'qa_status' => 'n/a', 'done_by' => $user['name']], $row));
}

/** Incoming materials against a PO. Items flagged "QA required" wait in quarantine until inspected. */
function inv_receive(array $b, array $user): array
{
    $po_id = $b['po_id'] ?? null;
    $lines = $b['lines'] ?? [];
    $po = ($po_id ? Db::get('purchase_orders', (string) $po_id) : null) ?? fail(404, 'PO not found');
    if (!in_array($po['status'], ['approved', 'partially received'], true)) fail(400, 'Only approved POs can be received');
    $prior = Db::list('stock_moves', ['po_id' => $po_id]);
    $value = 0.0;
    foreach (array_filter($lines, fn($l) => num($l['qty'] ?? 0) > 0) as $l) {
        $it = inv_item($l['item_id'] ?? null);
        $pl = null;
        foreach ($po['lines'] ?? [] as $x) if (($x['item_id'] ?? null) === ($l['item_id'] ?? null)) { $pl = $x; break; }
        $cost = num($pl['price'] ?? 0) ?: num($it['unit_cost'] ?? 0);
        $qa = !empty($it['qa_required']);
        inv_move(['move_type' => 'receipt', 'item_id' => $it['id'], 'qty' => num($l['qty']), 'unit_cost' => $cost, 'po_id' => $po_id,
            'project_id' => $po['project_id'] ?? null, 'ref' => $po['po_no'], 'qa_status' => $qa ? 'pending' : 'n/a'], $user);
        if (!$qa) { inv_bump($it, num($l['qty'])); $value += num($l['qty']) * $cost; }
    }
    if ($value) journal(today(), $po['po_no'], 'Goods received', [['1300', $value, 0], ['2000', 0, $value]]);
    $all = array_filter($prior, fn($m) => $m['move_type'] === 'receipt');
    foreach ($lines as $l) $all[] = ['move_type' => 'receipt', 'item_id' => $l['item_id'] ?? null, 'qty' => num($l['qty'] ?? 0)];
    $done = true;
    foreach (array_filter($po['lines'] ?? [], fn($l) => !empty($l['item_id'])) as $l) {
        $got = sum(array_filter($all, fn($m) => ($m['item_id'] ?? null) === $l['item_id']), 'qty');
        if ($got < num($l['qty'] ?? 0)) { $done = false; break; }
    }
    if ($done && !Db::list('bills', ['po_id' => $po_id])) {
        Db::insert('bills', ['bill_no' => Db::nextNo('bills', 'bill_no', 'BILL-'), 'supplier_id' => $po['supplier_id'], 'po_id' => $po_id,
            'bill_date' => today(), 'due_date' => add_days(today(), 30), 'amount' => $po['total'], 'status' => 'draft']);
    }
    return Db::update('purchase_orders', $po_id, ['status' => $done ? 'received' : 'partially received']);
}

function inv_qa(array $b, array $user): array
{
    $move_id = $b['move_id'] ?? null;
    $m = ($move_id ? Db::get('stock_moves', (string) $move_id) : null) ?? fail(404, 'Receipt not found');
    if (($m['qa_status'] ?? '') !== 'pending') fail(400, 'This receipt is not awaiting QA');
    $ok = max(0.0, min(num($m['qty']), num($b['qty_accepted'] ?? 0)));
    $rejected = num($m['qty']) - $ok;
    $result = !$rejected ? 'passed' : ($ok ? 'partial' : 'failed');
    $remarks = $b['remarks'] ?? null;
    Db::insert('qa_inspections', ['move_id' => $move_id, 'item_id' => $m['item_id'], 'qty_inspected' => $m['qty'], 'qty_accepted' => $ok,
        'qty_rejected' => $rejected, 'result' => $result, 'inspector' => $user['name'], 'remarks' => $remarks, 'inspected_at' => now_iso()]);
    if ($ok) {
        inv_bump(inv_item($m['item_id']), $ok);
        $v = $ok * num($m['unit_cost'] ?? 0);
        journal(today(), $m['ref'], 'Goods received (QA passed)', [['1300', $v, 0], ['2000', 0, $v]]);
    }
    if ($rejected) {
        inv_move(['move_type' => 'return out', 'item_id' => $m['item_id'], 'qty' => $rejected, 'unit_cost' => $m['unit_cost'] ?? null,
            'po_id' => $m['po_id'] ?? null, 'ref' => $m['ref'] ?? null, 'remarks' => 'QA rejected: ' . ($remarks ?? '')], $user);
    }
    return Db::update('stock_moves', $move_id, ['qa_status' => $result]);
}

function inv_project_material(string $project_id, $item_id): ?array
{
    foreach (Db::list('project_materials', ['project_id' => $project_id]) as $m) if (($m['item_id'] ?? null) === $item_id) return $m;
    return null;
}

function inv_issue(array $b, array $user): array
{
    $item_id = $b['item_id'] ?? null;
    $project_id = $b['project_id'] ?? null;
    $it = inv_item($item_id);
    $q = num($b['qty'] ?? 0);
    if ($q <= 0) fail(400, 'Quantity must be greater than zero');
    if ($q > num($it['on_hand'] ?? 0)) fail(400, 'Only ' . num($it['on_hand'] ?? 0) . ' ' . ($it['uom'] ?? '') . ' of ' . $it['name'] . ' on hand');
    $ref = Db::nextNo('stock_moves', 'ref', 'ISS-');
    inv_bump($it, -$q);
    if ($project_id) {
        $cost = amt($q * num($it['unit_cost'] ?? 0));
        Db::insert('project_costs', ['project_id' => $project_id, 'cost_date' => today(), 'category' => 'material', 'amount' => $cost,
            'description' => "Issued $q " . ($it['uom'] ?? '') . ' ' . $it['name'], 'ref' => $ref]);
        journal(today(), $ref, 'Material issue', [['5000', $cost, 0], ['1300', 0, $cost]], $project_id);
        if ($pm = inv_project_material($project_id, $item_id)) Db::update('project_materials', $pm['id'], ['qty_issued' => num($pm['qty_issued'] ?? 0) + $q]);
    }
    return inv_move(['move_type' => 'issue', 'item_id' => $item_id, 'qty' => $q, 'unit_cost' => $it['unit_cost'] ?? null, 'project_id' => $project_id,
        'ref' => $ref, 'remarks' => $b['remarks'] ?? null], $user);
}

/** kind: 'from project' (back into stock, credits the project) or 'to supplier' (out of stock). */
function inv_return(array $b, array $user): array
{
    $item_id = $b['item_id'] ?? null;
    $project_id = $b['project_id'] ?? null;
    $it = inv_item($item_id);
    $q = num($b['qty'] ?? 0);
    if ($q <= 0) fail(400, 'Quantity must be greater than zero');
    $ref = Db::nextNo('stock_moves', 'ref', 'RET-');
    $uc = num($it['unit_cost'] ?? 0);
    if (($b['kind'] ?? '') === 'to supplier') {
        if ($q > num($it['on_hand'] ?? 0)) fail(400, 'Only ' . num($it['on_hand'] ?? 0) . ' on hand');
        inv_bump($it, -$q);
        journal(today(), $ref, 'Return to supplier', [['2000', $q * $uc, 0], ['1300', 0, $q * $uc]]);
        return inv_move(['move_type' => 'return out', 'item_id' => $item_id, 'qty' => $q, 'unit_cost' => $it['unit_cost'] ?? null, 'ref' => $ref, 'remarks' => $b['remarks'] ?? null], $user);
    }
    inv_bump($it, $q);
    if ($project_id) {
        $cost = amt($q * $uc);
        Db::insert('project_costs', ['project_id' => $project_id, 'cost_date' => today(), 'category' => 'material', 'amount' => -$cost,
            'description' => "Returned $q " . ($it['uom'] ?? '') . ' ' . $it['name'], 'ref' => $ref]);
        journal(today(), $ref, 'Material return', [['1300', $cost, 0], ['5000', 0, $cost]], $project_id);
        if ($pm = inv_project_material($project_id, $item_id)) Db::update('project_materials', $pm['id'], ['qty_issued' => max(0, num($pm['qty_issued'] ?? 0) - $q)]);
    }
    return inv_move(['move_type' => 'return in', 'item_id' => $item_id, 'qty' => $q, 'unit_cost' => $it['unit_cost'] ?? null, 'project_id' => $project_id,
        'ref' => $ref, 'remarks' => $b['remarks'] ?? null], $user);
}

function inv_adjust(array $b, array $user, ?string $ref = null): array
{
    $it = inv_item($b['item_id'] ?? null);
    $q = num($b['qty'] ?? 0);
    $remarks = $b['remarks'] ?? '';
    if (!$q) fail(400, 'Enter a non-zero adjustment quantity');
    if (!truthy($remarks)) fail(400, 'A reason is required for adjustments');
    inv_bump($it, $q);
    $value = abs($q) * num($it['unit_cost'] ?? 0);
    journal(today(), $ref ?: 'ADJ', "Inventory adjustment: $remarks", $q > 0 ? [['1300', $value, 0], ['5900', 0, $value]] : [['5900', $value, 0], ['1300', 0, $value]]);
    return inv_move(['move_type' => 'adjustment', 'item_id' => $it['id'], 'qty' => $q, 'unit_cost' => $it['unit_cost'] ?? null,
        'ref' => $ref ?: Db::nextNo('stock_moves', 'ref', 'ADJ-'), 'remarks' => $remarks], $user);
}

// ---- Physical inventory: snapshot system quantities, enter counts, post variances as adjustments ----
function inv_start_count(array $b): array
{
    $category = $b['category'] ?? '';
    $items = array_values(array_filter(Db::list('items'), fn($i) => !$category || ($i['category'] ?? null) === $category));
    usort($items, fn($a, $c) => strcasecmp((string) ($a['code'] ?? ''), (string) ($c['code'] ?? '')));
    return Db::insert('stock_counts', ['count_no' => Db::nextNo('stock_counts', 'count_no', 'PI-'), 'count_date' => today(), 'status' => 'draft', 'remarks' => $b['remarks'] ?? null,
        'lines' => array_map(fn($i) => ['item_id' => $i['id'], 'code' => $i['code'] ?? null, 'name' => $i['name'] ?? null, 'uom' => $i['uom'] ?? null,
            'location' => $i['location'] ?? null, 'system_qty' => num($i['on_hand'] ?? 0), 'counted_qty' => null], $items)]);
}

function inv_post_count(string $id, array $user): array
{
    $c = Db::get('stock_counts', $id) ?? fail(404, 'Count not found');
    if ($c['status'] === 'posted') fail(400, 'Count already posted');
    $adjusted = 0;
    $lines = $c['lines'] ?? [];
    foreach ($lines as &$l) {
        if (!array_key_exists('counted_qty', $l) || $l['counted_qty'] === null || $l['counted_qty'] === '') continue;
        $it = inv_item($l['item_id']);
        $diff = r2(num($l['counted_qty']) - num($it['on_hand'] ?? 0));
        $l['variance'] = $diff;
        if ($diff) { inv_adjust(['item_id' => $l['item_id'], 'qty' => $diff, 'remarks' => 'Physical inventory ' . $c['count_no']], $user, $c['count_no']); $adjusted++; }
    }
    unset($l);
    Db::update('stock_counts', $id, ['status' => 'posted', 'lines' => $lines]);
    return ['adjusted' => $adjusted];
}

// ---- Finance ----
function fin_post_invoice(string $id): array
{
    $inv = Db::get('invoices', $id) ?? fail(404, 'Invoice not found');
    if ($inv['status'] !== 'draft') fail(400, 'Invoice already posted');
    $date = $inv['invoice_date'] ?? today();
    journal($date, $inv['invoice_no'], 'Customer invoice', [['1200', $inv['amount'] ?? 0, 0], ['4000', 0, $inv['amount'] ?? 0]], $inv['project_id'] ?? null);
    return Db::update('invoices', $id, ['status' => 'posted', 'invoice_date' => $date]);
}

function fin_pay(string $table, string $id): array
{
    $doc = Db::get($table, $id) ?? fail(404, 'Document not found');
    if (($doc['status'] ?? '') === 'paid') fail(400, 'Already paid');
    $ref = $doc['invoice_no'] ?? $doc['bill_no'] ?? null;
    $a = $doc['amount'] ?? 0;
    journal(today(), $ref, 'Payment', $table === 'invoices' ? [['1000', $a, 0], ['1200', 0, $a]] : [['2000', $a, 0], ['1000', 0, $a]]);
    return Db::update($table, $id, ['status' => 'paid']);
}

function fin_trial_balance(): array
{
    $accounts = Db::list('accounts');
    usort($accounts, fn($a, $b) => strcmp((string) $a['code'], (string) $b['code']));
    $tot = [];
    foreach (Db::raw('SELECT account_id, SUM(debit) AS d, SUM(credit) AS c FROM `journal_entries` GROUP BY account_id') as $r) $tot[$r['account_id']] = $r;
    return array_map(function ($a) use ($tot) {
        $d = num($tot[$a['id']]['d'] ?? 0);
        $c = num($tot[$a['id']]['c'] ?? 0);
        return ['code' => $a['code'], 'name' => $a['name'], 'type' => $a['type'] ?? null, 'debit' => amt(max(0, $d - $c)), 'credit' => amt(max(0, $c - $d))];
    }, $accounts);
}

function routes_inventory(callable $route): void
{
    $route('POST', 'inventory/receive', act(['inventory'], fn($p, $b, $u) => inv_receive($b, $u)));
    $route('POST', 'inventory/qa', act(['inventory'], fn($p, $b, $u) => inv_qa($b, $u)));
    $route('POST', 'inventory/issue', act(['inventory'], fn($p, $b, $u) => inv_issue($b, $u)));
    $route('POST', 'inventory/return', act(['inventory'], fn($p, $b, $u) => inv_return($b, $u)));
    $route('POST', 'inventory/adjust', act(['inventory'], fn($p, $b, $u) => inv_adjust($b, $u)));
    $route('POST', 'inventory/counts/start', act(['inventory'], fn($p, $b) => inv_start_count($b)));
    $route('PUT', 'inventory/counts/{id}', act(['inventory'], function ($p, $b) {
        $c = Db::get('stock_counts', $p['id']) ?? fail(404, 'Count not found');
        if ($c['status'] === 'posted') fail(400, 'Count already posted');
        return Db::update('stock_counts', $c['id'], ['lines' => $b['lines'] ?? null]);
    }));
    $route('POST', 'inventory/counts/{id}/post', act(['inventory'], fn($p, $b, $u) => inv_post_count($p['id'], $u)));

    $route('POST', 'finance/invoices/{id}/post', act(['finance'], fn($p) => fin_post_invoice($p['id'])));
    $route('POST', 'finance/{table}/{id}/pay', act(['finance'], fn($p) => in_array($p['table'], ['invoices', 'bills'], true) ? fin_pay($p['table'], $p['id']) : fail(404, 'Unknown document')));
    $route('GET', 'finance/trial-balance', act(['finance'], fn() => fin_trial_balance()));
}
