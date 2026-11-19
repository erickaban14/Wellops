<?php
// Loads configuration, the data model and role table, and wires up the database and auth classes.

date_default_timezone_set('UTC');
define('APP_ROOT', dirname(__DIR__)); // folder holding config.php (htdocs on the host)
define('APP_DATA', __DIR__ . '/data');

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Auth.php';

$configFile = APP_ROOT . '/config.php';
if (!is_file($configFile)) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo '{"error":"Not configured: copy config.sample.php to config.php and fill in the database settings."}';
    exit;
}
$CONFIG = require $configFile;

// models.json is kept as raw text too: it is served verbatim in /api/me (re-encoding would turn empty objects into arrays).
$MODELS_JSON = file_get_contents(APP_DATA . '/models.json');
$ROLES = json_decode(file_get_contents(APP_DATA . '/roles.json'), true);

Db::init($CONFIG['db'], json_decode($MODELS_JSON, true));
Auth::init($ROLES, $CONFIG);
