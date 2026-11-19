<?php
// Shared service helpers (port of server/services/common.js).

function setting(string $key, $fallback = null)
{
    $row = Db::list('settings', ['key' => $key])[0] ?? null;
    return $row['value'] ?? $fallback;
}

/** Post a balanced journal entry. $lines: [[accountCode, debit, credit], ...] */
function journal($date, $ref, $memo, array $lines, $project_id = null): void
{
    $accounts = Db::raw('SELECT id, code FROM `accounts`');
    $code = [];
    foreach ($accounts as $a) $code[$a['code']] ??= $a['id'];
    $rows = [];
    foreach ($lines as [$c, $debit, $credit]) {
        if (!num($debit) && !num($credit)) continue;
        $rows[] = ['entry_date' => $date, 'ref' => $ref, 'memo' => $memo, 'account_id' => $code[(string) $c] ?? null,
            'debit' => r2($debit), 'credit' => r2($credit), 'project_id' => $project_id];
    }
    foreach ($rows as $r) if (!$r['account_id']) return; // unknown account code: skip posting, like the Node version
    if ($rows) Db::insertMany('journal_entries', $rows);
}

function notify(string $role, string $title, string $body, array $extra = []): array
{
    return Db::insert('notifications', ['role' => $role, 'title' => $title, 'body' => $body, 'kind' => 'info', 'read' => false] + $extra);
}
