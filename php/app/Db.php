<?php
// Storage layer (port of server/store/*). Plain PDO; table and column names are whitelisted against models.json.

final class Db
{
    private static ?PDO $pdo = null;
    private static array $cfg = [];
    public static array $models = [];
    private static int $depth = 0;

    public static function init(array $cfg, array $models): void
    {
        self::$cfg = $cfg;
        self::$models = $models;
    }

    public static function pdo(): PDO
    {
        if (!self::$pdo) {
            $c = self::$cfg;
            $dsn = 'mysql:host=' . $c['host'] . ';port=' . ($c['port'] ?? 3306) . ';dbname=' . $c['name'] . ';charset=utf8mb4';
            self::$pdo = new PDO($dsn, $c['user'], $c['pass'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_STRINGIFY_FETCHES => false,
            ]);
            self::$pdo->exec("SET time_zone = '+00:00'");
        }
        return self::$pdo;
    }

    public static function connected(): bool { return self::$pdo !== null; }

    public static function model(string $table): array
    {
        return self::$models[$table] ?? fail(404, "Unknown table $table");
    }

    // ---- raw access (for services) ----
    public static function q(string $sql, array $params = []): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute(array_map(fn($v) => is_bool($v) ? (int) $v : $v, array_values($params)));
        return $st;
    }
    public static function raw(string $sql, array $params = []): array { return self::q($sql, $params)->fetchAll(); }

    public static function tx(callable $fn)
    {
        $outer = self::$depth === 0;
        if ($outer) self::pdo()->beginTransaction();
        self::$depth++;
        try {
            $r = $fn();
            self::$depth--;
            if ($outer) self::pdo()->commit();
            return $r;
        } catch (Throwable $e) {
            self::$depth--;
            if ($outer && self::pdo()->inTransaction()) self::pdo()->rollBack();
            throw $e;
        }
    }

    // ---- value conversion ----
    private static function col(string $table, string $k): ?array
    {
        $m = self::model($table);
        if (isset($m['fields'][$k])) return $m['fields'][$k];
        if (in_array($k, ['id', 'created_at', 'updated_at'], true)) return ['type' => $k === 'id' ? 'text' : 'datetime', 'label' => $k];
        return null;
    }

    private static function sqlDatetime($v, string $label): ?string
    {
        if ($v === null || $v === '') return null;
        try {
            $d = new DateTimeImmutable((string) $v, new DateTimeZone('UTC'));
        } catch (Exception $e) {
            fail(400, "$label is not a valid date");
        }
        return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
    }

    /** Convert one value from API/JS form to its database form. */
    public static function toDb(array $f, $v)
    {
        switch ($f['type']) {
            case 'number':
                return ($v === '' || $v === null || !is_numeric($v)) ? null : (float) $v;
            case 'bool':
                return ($v === true || $v === 'true' || $v === 1 || $v === '1') ? 1 : 0;
            case 'date':
                if (!$v) return null;
                if (!preg_match('/^\d{4}-\d{2}-\d{2}/', (string) $v)) fail(400, ($f['label'] ?? 'Date') . ' is not a valid date');
                return substr((string) $v, 0, 10);
            case 'datetime':
                return self::sqlDatetime($v, $f['label'] ?? 'Date');
            case 'ref':
                return $v ?: null;
            case 'json':
                if (is_string($v)) {
                    if ($v === '') return null;
                    $d = json_decode($v, true);
                    if ($d === null && trim($v) !== 'null') fail(400, ($f['label'] ?? 'Value') . ' is not valid JSON');
                    $v = $d;
                }
                return $v === null ? null : to_json($v);
            default:
                if ($v === null) return null;
                return is_scalar($v) ? (string) $v : to_json($v);
        }
    }

    /** Convert a database row to the shape the browser expects (JS-like types, ISO timestamps). */
    public static function hydrate(string $table, array $row): array
    {
        unset($row['_row']);
        foreach ($row as $k => $v) {
            if ($v === null) continue;
            $f = self::col($table, $k);
            if (!$f) continue;
            switch ($f['type']) {
                case 'number': $row[$k] = (float) $v; break;
                case 'bool': $row[$k] = (bool) $v; break;
                case 'json': $row[$k] = json_decode((string) $v, true); break;
                case 'datetime': $row[$k] = str_replace(' ', 'T', (string) $v) . 'Z'; break;
            }
        }
        return $row;
    }

    private static function clean(string $table, array $row, bool $partial): array
    {
        $out = [];
        foreach (self::model($table)['fields'] as $k => $f) {
            if (!array_key_exists($k, $row)) {
                if (!$partial && $f['type'] === 'bool') $out[$k] = 0;
                continue;
            }
            $out[$k] = self::toDb($f, $row[$k]);
        }
        return $out;
    }

    public static function nowSql(): string { return gmdate('Y-m-d H:i:s') . '.' . sprintf('%03d', (int) (microtime(true) * 1000) % 1000); }

    // ---- CRUD ----
    public static function list(string $table, array $where = []): array
    {
        self::model($table);
        $sql = "SELECT * FROM `$table`";
        $params = [];
        $conds = [];
        foreach ($where as $k => $v) {
            $f = self::col($table, $k) ?? fail(400, "Unknown field $k");
            $v = self::toDb($f, $v);
            if ($v === null) { $conds[] = "`$k` IS NULL"; } else { $conds[] = "`$k` = ?"; $params[] = $v; }
        }
        if ($conds) $sql .= ' WHERE ' . implode(' AND ', $conds);
        $sql .= ' ORDER BY `_row`';
        return array_map(fn($r) => self::hydrate($table, $r), self::raw($sql, $params));
    }

    public static function get(string $table, string $id): ?array
    {
        self::model($table);
        $r = self::raw("SELECT * FROM `$table` WHERE id = ?", [$id])[0] ?? null;
        return $r ? self::hydrate($table, $r) : null;
    }

    private static function insertRows(string $table, array $dbRows): void
    {
        if (!$dbRows) return;
        $cols = array_merge(['id', 'created_at', 'updated_at'], array_keys(self::model($table)['fields']));
        $colSql = '`' . implode('`,`', $cols) . '`';
        $one = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
        // chunk so a single statement stays within the placeholder / packet limits
        $perChunk = max(1, intdiv(5000, count($cols)));
        foreach (array_chunk($dbRows, $perChunk) as $chunk) {
            $params = [];
            foreach ($chunk as $r) foreach ($cols as $c) $params[] = $r[$c] ?? null;
            self::q("INSERT INTO `$table` ($colSql) VALUES " . implode(',', array_fill(0, count($chunk), $one)), $params);
        }
    }

    private static function build(string $table, array $r): array
    {
        $ts = self::nowSql();
        return ['id' => $r['id'] ?? uuid4(), 'created_at' => $ts, 'updated_at' => $ts] + self::clean($table, $r, false);
    }

    public static function insert(string $table, array $row): array
    {
        $db = self::build($table, $row);
        self::insertRows($table, [$db]);
        return self::hydrate($table, $db);
    }

    /** Insert several rows; returns them in order. */
    public static function insertMany(string $table, array $rows): array
    {
        $db = array_map(fn($r) => self::build($table, $r), array_values($rows));
        self::insertRows($table, $db);
        return array_map(fn($r) => self::hydrate($table, $r), $db);
    }

    /** Insert rows exactly as exported (keeps id/created_at/updated_at). Used by install and migration. */
    public static function importRows(string $table, array $rows): void
    {
        $db = [];
        foreach ($rows as $r) {
            $d = self::clean($table, $r, false);
            $d['id'] = $r['id'] ?? uuid4();
            $d['created_at'] = self::sqlDatetime($r['created_at'] ?? null, 'created_at') ?? self::nowSql();
            $d['updated_at'] = self::sqlDatetime($r['updated_at'] ?? null, 'updated_at') ?? self::nowSql();
            $db[] = $d;
        }
        self::insertRows($table, $db);
    }

    public static function update(string $table, string $id, array $patch): array
    {
        $data = self::clean($table, $patch, true);
        $data['updated_at'] = self::nowSql();
        $sets = [];
        foreach (array_keys($data) as $k) $sets[] = "`$k` = ?";
        self::q("UPDATE `$table` SET " . implode(', ', $sets) . ' WHERE id = ?', array_merge(array_values($data), [$id]));
        $row = self::get($table, $id);
        if (!$row) fail(404, self::model($table)['label'] . ' record not found');
        return $row;
    }

    public static function remove(string $table, string $id): void
    {
        self::model($table);
        self::q("DELETE FROM `$table` WHERE id = ?", [$id]);
    }

    /** Next document number such as PO-0007. Concurrency-safe: backed by the _counters table. */
    public static function nextNo(string $table, string $field, string $prefix): string
    {
        self::model($table);
        $name = "$table.$field";
        return self::tx(function () use ($table, $field, $prefix, $name) {
            // First use: start from the highest number already stored.
            self::q("INSERT IGNORE INTO `_counters` (name, n) SELECT ?, COALESCE(MAX(CAST(REGEXP_REPLACE(`$field`, '[^0-9]', '') AS UNSIGNED)), 0) FROM `$table`", [$name]);
            self::q('UPDATE `_counters` SET n = LAST_INSERT_ID(n + 1) WHERE name = ?', [$name]);
            $n = (int) self::raw('SELECT LAST_INSERT_ID() AS n')[0]['n'];
            return $prefix . pad($n);
        });
    }
}
