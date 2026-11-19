<?php
// Documents (manual files kept in uploads/, served only through the API) and sync status.

function docs_dir(): string
{
    $dir = APP_ROOT . '/uploads';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
        file_put_contents($dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");
    }
    return $dir;
}

function routes_misc(callable $route): void
{
    $route('POST', 'documents/{id}/upload', act(['planning', 'assets'], function ($p, $b) {
        $doc = Db::get('documents', $p['id']) ?? fail(404, 'Document not found');
        $file_name = $b['file_name'] ?? '';
        $data = $b['data'] ?? '';
        if (!$file_name || !$data) fail(400, 'No file received');
        $bin = base64_decode((string) $data, true);
        if ($bin === false) fail(400, 'The file could not be decoded');
        $key = $doc['id'] . '-' . preg_replace('/[^\w.\-]+/', '_', (string) $file_name);
        if (file_put_contents(docs_dir() . '/' . basename($key), $bin) === false) fail(500, 'The file could not be stored');
        Db::update('documents', $doc['id'], ['file_name' => $file_name, 'mime' => $b['mime'] ?? null, 'storage_path' => $key]);
        return ['ok' => true];
    }));

    $route('GET', 'documents/{id}/file', function ($p) {
        $doc = Db::get('documents', $p['id']);
        $path = $doc && !empty($doc['storage_path']) ? docs_dir() . '/' . basename($doc['storage_path']) : null;
        if (!$path || !is_file($path)) fail(404, 'No file uploaded for this document');
        header('Content-Type: ' . (preg_match('#^[\w.+-]+/[\w.+-]+$#', (string) ($doc['mime'] ?? '')) ? $doc['mime'] : 'application/octet-stream'));
        header('Content-Disposition: inline; filename="' . rawurlencode((string) ($doc['file_name'] ?? 'file')) . '"');
        header('Content-Security-Policy: sandbox');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    });

    // On-premise sync: automatic push is not possible on this host (see HANDOFF.md 7.2); only the status page works.
    $route('GET', 'sync/status', act(['settings'], fn() => ['configured' => false, 'primary' => 'mysql', 'interval_min' => 0,
        'log' => array_slice(array_reverse(Db::list('sync_log')), 0, 15)]));
    $route('POST', 'sync/run', act(['settings'], fn() => fail(409, 'Automatic sync to the on-premise database is not available on this host. Use a manual export instead.')));
}
