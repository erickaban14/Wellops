<?php
// One-time: converts an existing database from US dollars to Omani rials (1 USD = 0.3845 OMR).
//   Web:  https://your-site/convert-omr.php?key=<install_key>
//   CLI:  php convert-omr.php
// Refuses to run when the currency setting is already OMR. DELETE THIS FILE after use.

@ini_set('display_errors', '0'); error_reporting(E_ALL);
if (PHP_SAPI !== 'cli') header('Content-Type: text/plain; charset=utf-8');
set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    echo "\nCONVERSION FAILED (nothing was changed): " . $e->getMessage() . "\n  at " . basename($e->getFile()) . ':' . $e->getLine() . "\n";
});

require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/currency.php';

if (PHP_SAPI !== 'cli' && !hash_equals((string) $CONFIG['install_key'], (string) ($_GET['key'] ?? ''))) { http_response_code(403); exit("Forbidden: wrong or missing key.\n"); }
$cur = Db::list('settings', ['key' => 'currency'])[0]['value'] ?? 'USD';
if ($cur === 'OMR') exit("Already in Omani rials; nothing to do. Delete convert-omr.php.\n");
if ($cur !== 'USD') exit("Currency setting is '$cur', not USD; refusing to convert.\n");

foreach (convert_to_omr() as $line) echo "  $line\n";
echo "\nDone: all amounts are now in Omani rials (1 USD = " . USD_TO_OMR . " OMR). Now DELETE convert-omr.php from the server.\n";
