<?php
// One-time installer: creates the tables and loads master data (and optionally the demo scenario).
//   Web:  https://your-site/install.php?key=<install_key>&demo=1      (demo=0 loads master data + one admin only)
//   CLI:  php install.php --demo | php install.php --master
// Refuses to run twice (app/installed.lock). DELETE THIS FILE after use.

require __DIR__ . '/app/bootstrap.php';

$cli = PHP_SAPI === 'cli';
if (!$cli) {
    header('Content-Type: text/plain; charset=utf-8');
    if (!hash_equals((string) $CONFIG['install_key'], (string) ($_GET['key'] ?? ''))) { http_response_code(403); exit("Forbidden: wrong or missing key.\n"); }
}
$demo = $cli ? in_array('--demo', $argv ?? [], true) : (($_GET['demo'] ?? '1') !== '0');
$lock = __DIR__ . '/app/installed.lock';
if (is_file($lock)) exit("Already installed (remove app/installed.lock to run again). Delete install.php.\n");
set_time_limit(300);

// 1. Tables
$sql = file_get_contents(APP_DATA . '/schema.sql');
foreach (array_filter(array_map('trim', explode(";\n", $sql))) as $stmt) Db::pdo()->exec($stmt);
echo "Tables ready.\n";

// 2. Data
if (Db::raw('SELECT COUNT(*) AS n FROM `users`')[0]['n'] > 0) exit("Database already has users; skipping data load.\n");
$seed = json_decode(file_get_contents(APP_DATA . '/seed.json'), true);
$master = ['settings', 'accounts', 'suppliers', 'items', 'machines', 'api_standards', 'training_courses', 'training_matrix',
    'approval_rules', 'activity_templates', 'material_templates', 'crew_templates', 'kpi_templates'];
$tables = $demo ? array_keys($seed) : $master;

Db::tx(function () use ($seed, $tables, $demo, $CONFIG) {
    $pw = (string) $CONFIG['seed_password'];
    foreach ($tables as $t) {
        if (!isset(Db::$models[$t]) || $t === 'users') continue; // users are loaded below with fresh password hashes
        $rows = $seed[$t] ?? [];
        Db::importRows($t, $rows);
        echo sprintf("  %-20s %d rows\n", $t, count($rows));
    }
    // Users: always create real password hashes here (the Node scrypt hashes are not portable).
    $users = $seed['users'] ?? [];
    if (!$demo) {
        $users = array_values(array_filter($users, fn($u) => $u['role'] === 'admin'));
        foreach ($users as &$u) $u['employee_id'] = null;
        unset($u);
    }
    foreach ($users as &$u) $u['password_hash'] = Auth::hash($pw);
    unset($u);
    Db::importRows('users', $users);
    echo sprintf("  %-20s %d rows\n", 'users', count($users));
});

file_put_contents($lock, gmdate('c') . "\n");
echo "\nDone (" . ($demo ? 'demo scenario' : 'master data only') . "). Sign in as <role>@wellops.test (e.g. admin@wellops.test) with the seed_password from config.php.\n";
echo "Now DELETE install.php from the server.\n";
