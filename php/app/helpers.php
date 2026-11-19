<?php
// Shared helpers (port of server/util.js). Written for PHP 8.0+.

class HttpError extends Exception
{
    public int $status;
    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function fail(int $status, string $message)
{
    throw new HttpError($status, $message);
}

function today(): string { return gmdate('Y-m-d'); }
function now_iso(): string { return gmdate('Y-m-d\TH:i:s') . '.' . sprintf('%03d', (int) (microtime(true) * 1000) % 1000) . 'Z'; }
function add_days($d, int $n): string
{
    return gmdate('Y-m-d', strtotime(substr((string) $d, 0, 10) . ' UTC') + $n * 86400);
}
function days_between($a, $b): int
{
    return (int) round((strtotime(substr((string) $b, 0, 10) . ' UTC') - strtotime(substr((string) $a, 0, 10) . ' UTC')) / 86400);
}
function overlap($a1, $a2, $b1, $b2): bool { return $a1 <= $b2 && $b1 <= $a2; }
function num($v): float { return is_numeric($v) ? (float) $v : 0.0; }
function r2($v): float { return round(num($v) * 100) / 100; }
function pad($n, int $w = 4): string { return str_pad((string) $n, $w, '0', STR_PAD_LEFT); }

/** JavaScript truthiness: "0" and "false" are truthy, unlike PHP. */
function truthy($v): bool
{
    return !($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0);
}

function by_id(array $rows): array
{
    $out = [];
    foreach ($rows as $r) $out[$r['id']] = $r;
    return $out;
}
function sum(array $rows, $f): float
{
    $t = 0.0;
    foreach ($rows as $r) $t += num(is_callable($f) ? $f($r) : ($r[$f] ?? 0));
    return $t;
}
function group_by(array $rows, $f): array
{
    $out = [];
    foreach ($rows as $r) $out[is_callable($f) ? $f($r) : ($r[$f] ?? '')][] = $r;
    return $out;
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** Purchase order total (server/services/procurement.js poTotal). */
function po_total($lines): float
{
    return r2(sum(is_array($lines) ? $lines : [], fn($l) => num($l['qty'] ?? 0) * num($l['price'] ?? 0)));
}

/** Like JavaScript's Number.toLocaleString() (en-US, up to 3 decimals): used in notification texts. */
function fmt_num($n): string
{
    $s = number_format((float) $n, 3, '.', ',');
    return rtrim(rtrim($s, '0'), '.');
}

function req_body(): array { return $GLOBALS['BODY'] ?? []; }

/**
 * Wrap a service call as a route handler: checks app access, runs inside one transaction,
 * and passes ($params, $body, $user) to $fn.
 */
function act(array $apps, callable $fn): callable
{
    return function (array $p) use ($apps, $fn) {
        if ($apps) Auth::need(...$apps);
        return Db::tx(fn() => $fn($p, req_body(), Auth::$user));
    };
}

const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR;
function to_json($v): string { return json_encode($v, JSON_FLAGS); }
