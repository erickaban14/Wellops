<?php
// Local development only (mimics the host's .htaccess):
//   cd php && php -S localhost:8080 -t ../public dev-router.php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/api')) {
    require __DIR__ . '/api/index.php';
    return true;
}
$file = realpath(__DIR__ . '/../public' . $path);
if ($file && is_file($file) && str_starts_with($file, realpath(__DIR__ . '/../public'))) return false; // let the built-in server serve it
header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/../public/index.html');
