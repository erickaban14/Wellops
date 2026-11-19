<?php
// Front controller for every /api/* request (port of server/index.js). Business modules live in app/services/.

require __DIR__ . '/../app/bootstrap.php';
foreach (glob(APP_DATA . '/../services/*.php') ?: [] as $f) require_once $f;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function send($data, int $status = 200): void
{
    http_response_code($status);
    echo is_string($data) && ($GLOBALS['RAW_JSON'] ?? false) ? $data : to_json($data);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$path = trim((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
$path = preg_replace('#^(?:.*?/)?api/?#', '', $path, 1); // tolerate the API living in a sub-folder
$raw = file_get_contents('php://input');
$body = $raw !== '' ? (json_decode($raw, true) ?? []) : [];
if (!is_array($body)) $body = [];

// ---------- helpers for the generic data API ----------
function strip_hidden(array $m, ?array $row): ?array
{
    if (!$row) return $row;
    foreach ($m['fields'] as $k => $f) {
        if (!empty($f['hidden']) && $k !== 'client_id' && $k !== 'storage_path') unset($row[$k]);
    }
    if (array_key_exists('storage_path', $row)) {
        $row['has_file'] = (bool) $row['storage_path'];
        unset($row['storage_path']);
    }
    return $row;
}
function can_read(array $m): bool
{
    return (empty($m['private']) && $m['name'] !== 'users') || Auth::can('hr', 'finance', 'settings');
}
function can_write(array $m): bool
{
    return Auth::can(...$m['modules']) && ($m['name'] !== 'users' || (Auth::$user['role'] ?? '') === 'admin');
}
function prepare_row(array $m, array $body, ?array $existing): array
{
    foreach ($m['fields'] as $k => $f) {
        if (!empty($f['hidden']) || (!empty($f['ro']) && $existing)) unset($body[$k]);
        if (!empty($f['req']) && !$existing && !truthy($body[$k] ?? null)) fail(400, $f['label'] . ' is required');
        if (!empty($f['auto']) && !$existing && !truthy($body[$k] ?? null)) $body[$k] = Db::nextNo($m['name'], $k, $f['auto']);
    }
    if ($m['name'] === 'purchase_orders') {
        if (!empty($body['lines'])) $body['total'] = po_total($body['lines']);
        if (!$existing) $body = array_merge($body, ['status' => 'draft', 'approvals' => [], 'current_approver' => '']);
        elseif (!in_array($existing['status'] ?? '', ['draft', 'rejected'], true)) fail(400, 'A PO that is ' . $existing['status'] . ' cannot be edited');
    }
    if ($m['name'] === 'leaves' && !$existing && !truthy($body['status'] ?? null)) $body['status'] = 'requested';
    return $body;
}
function strong_password($pw): string
{
    return strlen((string) $pw) >= 8 ? (string) $pw : fail(400, 'Password must be at least 8 characters');
}
function my_notes(array $u): array
{
    return array_map(fn($r) => Db::hydrate('notifications', $r),
        Db::raw('SELECT * FROM `notifications` WHERE role = ? OR user_id = ? ORDER BY `_row` DESC', [$u['role'], $u['id']]));
}

// ---------- routes ----------
// Each route: [HTTP method, path pattern, handler]. {x} captures one path segment.
$public = ['GET public', 'POST login', 'POST demo-login', 'POST face/login', 'POST logout'];
$routes = [];
$route = function (string $m, string $p, callable $fn) use (&$routes) { $routes[] = [$m, $p, $fn]; };

$rolesMeta = [];
foreach ($ROLES as $k => $r) $rolesMeta[$k] = ['label' => $r['label'], 'group' => $r['group']];
$demoLogin = !empty($CONFIG['demo_login']);

$route('GET', 'public', fn() => ['demo_login' => $demoLogin, 'mode' => 'mysql', 'ready' => true, 'error' => '', 'roles' => $demoLogin ? $rolesMeta : new stdClass()]);
$route('POST', 'login', function () use ($body) {
    $email = strtolower((string) ($body['email'] ?? ''));
    $user = Db::raw('SELECT id FROM `users` WHERE LOWER(email) = ? LIMIT 1', [$email])[0] ?? null;
    $user = $user ? Db::get('users', $user['id']) : null;
    if (!$user || ($user['active'] ?? null) === false || !Auth::check($body['password'] ?? '', $user['password_hash'] ?? '')) fail(401, 'Wrong email or password');
    Auth::startSession($user);
    return Auth::publicUser($user);
});
$route('POST', 'demo-login', function () use ($body, $demoLogin) {
    if (!$demoLogin) fail(403, 'Demo login is disabled');
    $user = Db::list('users', ['role' => (string) ($body['role'] ?? '')])[0] ?? fail(404, 'No user with that role');
    Auth::startSession($user);
    return Auth::publicUser($user);
});
$route('POST', 'face/login', function () use ($body) {
    $user = Auth::matchFace($body['descriptor'] ?? null) ?? fail(401, 'Face not recognised. Use email and password, then enrol your face in your profile.');
    Auth::startSession($user);
    $vpn = Db::list('settings', ['key' => 'vpn_connect_url'])[0]['value'] ?? '';
    return Auth::publicUser($user) + ['vpn_connect_url' => $vpn];
});
$route('POST', 'logout', function () { Auth::endSession(); return ['ok' => true]; });

$route('GET', 'me', function () use ($MODELS_JSON, $rolesMeta) {
    $u = Auth::$user;
    $setting = fn($k, $d) => Db::list('settings', ['key' => $k])[0]['value'] ?? $d;
    $GLOBALS['RAW_JSON'] = true;
    return '{"user":' . to_json(Auth::publicUser($u)) . ',"meta":{"models":' . $MODELS_JSON . ',"roles":' . to_json($rolesMeta) . '},"mode":"mysql",'
        . '"sync_configured":false,"company":' . to_json($setting('company_name', 'ProStars ERP')) . ',"currency":' . to_json($setting('currency', 'USD')) . '}';
});
$route('POST', 'face/enroll', function () use ($body) {
    $d = $body['descriptor'] ?? null;
    if (!is_array($d) || count($d) !== 128) fail(400, 'Invalid face descriptor');
    Db::update('users', Auth::$user['id'], ['face_descriptor' => $d]);
    return ['ok' => true];
});
$route('POST', 'password', function () use ($body) {
    if (!Auth::check($body['current'] ?? '', Auth::$user['password_hash'] ?? '')) fail(400, 'Current password is wrong');
    Db::update('users', Auth::$user['id'], ['password_hash' => Auth::hash(strong_password($body['next'] ?? ''))]);
    return ['ok' => true];
});
$route('POST', 'users/{id}/reset-password', function ($p) use ($body) {
    if (Auth::$user['role'] !== 'admin') fail(403, 'Only an administrator can reset passwords');
    Db::update('users', $p['id'], ['password_hash' => Auth::hash(strong_password($body['next'] ?? ''))]);
    return ['ok' => true];
});
$route('GET', 'notifications', function () {
    $all = my_notes(Auth::$user);
    return ['unread' => count(array_filter($all, fn($n) => empty($n['read']))), 'items' => array_slice($all, 0, 30)];
});
$route('POST', 'notifications/read', function () {
    $u = Auth::$user;
    Db::q('UPDATE `notifications` SET `read` = 1, updated_at = UTC_TIMESTAMP(3) WHERE (role = ? OR user_id = ?) AND (`read` IS NULL OR `read` = 0)', [$u['role'], $u['id']]);
    return ['ok' => true];
});

// Cheap change feed used instead of server-sent events: which tables changed since a timestamp.
$route('GET', 'changes', function () {
    $now = now_iso();
    $since = $_GET['since'] ?? '';
    if ($since === '') return ['now' => $now, 'tables' => []];
    $since = Db::toDb(['type' => 'datetime', 'label' => 'since'], $since);
    $parts = [];
    foreach (array_keys(Db::$models) as $t) $parts[] = "(SELECT '$t' AS t FROM `$t` WHERE updated_at > ? LIMIT 1)";
    $rows = Db::raw(implode(' UNION ALL ', $parts), array_fill(0, count($parts), $since));
    return ['now' => $now, 'tables' => array_column($rows, 't')];
});

// ---------- generic data API (driven by models.json) ----------
$route('GET', 'data/{table}', function ($p) {
    $m = Db::model($p['table']);
    $where = [];
    foreach ($_GET as $k => $v) if (isset($m['fields'][$k]) && is_scalar($v)) $where[$k] = $v;
    $rows = Db::list($m['name'], $where);
    $ownOnly = !empty($m['private']) && !Auth::can('hr', 'finance');
    if ($m['name'] === 'payslips' && $ownOnly) $rows = array_values(array_filter($rows, fn($r) => $r['employee_id'] === Auth::$user['employee_id']));
    elseif (!can_read($m)) fail(403, 'No access');
    return array_map(fn($r) => strip_hidden($m, $r), $rows);
});
$route('GET', 'data/{table}/{id}', function ($p) {
    $m = Db::model($p['table']);
    if (!can_read($m)) fail(403, 'No access');
    return strip_hidden($m, Db::get($m['name'], $p['id']) ?? fail(404, 'Record not found'));
});
$route('POST', 'data/{table}', function ($p) use ($body, $CONFIG) {
    $m = Db::model($p['table']);
    if (!can_write($m)) fail(403, 'Your role cannot create ' . $m['label']);
    if ($m['name'] === 'leaves' && !Auth::can('hr')) $body = array_merge($body, ['employee_id' => Auth::$user['employee_id'], 'status' => 'requested']);
    $row = prepare_row($m, $body, null);
    if ($m['name'] === 'users') $row['password_hash'] = Auth::hash((string) ($body['password'] ?? '') ?: (string) $CONFIG['seed_password']);
    return strip_hidden($m, Db::insert($m['name'], $row));
});
$route('PUT', 'data/{table}/{id}', function ($p) use ($body) {
    $m = Db::model($p['table']);
    if (!can_write($m)) fail(403, 'Your role cannot edit ' . $m['label']);
    $existing = Db::get($m['name'], $p['id']) ?? fail(404, 'Record not found');
    if ($m['name'] === 'leaves' && !Auth::can('hr') && (($existing['employee_id'] ?? null) !== Auth::$user['employee_id'] || ($existing['status'] ?? '') !== 'requested')) fail(403, 'You can only change your own pending requests');
    return strip_hidden($m, Db::update($m['name'], $p['id'], prepare_row($m, $body, $existing)));
});
$route('DELETE', 'data/{table}/{id}', function ($p) {
    $m = Db::model($p['table']);
    if (!can_write($m)) fail(403, 'Your role cannot delete ' . $m['label']);
    if ($m['name'] === 'payroll_runs') foreach (Db::list('payslips', ['run_id' => $p['id']]) as $s) Db::remove('payslips', $s['id']);
    Db::remove($m['name'], $p['id']);
    return ['ok' => true];
});

// ---------- business modules (added by app/services/*.php) ----------
if (function_exists('register_service_routes')) register_service_routes($route);

// ---------- dispatch ----------
try {
    $matched = null;
    $allowed = [];
    foreach ($routes as [$m, $pattern, $fn]) {
        $re = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
        if (!preg_match($re, $path, $mm)) continue;
        $allowed[] = $m;
        if ($m === $method) { $matched = [$fn, array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY), $m . ' ' . $pattern]; break; }
    }
    if (!$matched) send(['error' => $allowed ? 'Method not allowed' : 'Not found'], $allowed ? 405 : 404);
    [$fn, $params, $key] = $matched;
    if (!in_array($key, $public, true)) Auth::require();
    $out = $fn(array_map('urldecode', $params));
    if ($out !== null) send($out);
} catch (HttpError $e) {
    send(['error' => $e->getMessage()], $e->status);
} catch (PDOException $e) {
    $code = (string) $e->getCode();
    if (!Db::connected()) send(['error' => 'The database is not reachable. Try again in a minute.'], 503);
    if ($code === '22001') send(['error' => 'A value is too long for its field'], 400);
    error_log('[api] ' . $e->getMessage());
    send(['error' => !empty($CONFIG['debug']) ? $e->getMessage() : 'Server error'], 500);
} catch (Throwable $e) {
    error_log('[api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    send(['error' => !empty($CONFIG['debug']) ? $e->getMessage() : 'Server error'], 500);
}
