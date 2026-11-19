<?php
// Sessions, passwords, role permissions and face matching (port of server/auth.js).

final class Auth
{
    public static array $roles = [];
    public static array $config = [];
    public static ?array $user = null;
    private const LIFETIME = 43200; // 12 hours

    public static function init(array $roles, array $config): void
    {
        self::$roles = $roles;
        self::$config = $config;
    }

    private static function openSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) return;
        $https = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
        session_name('sid');
        session_set_cookie_params(['lifetime' => self::LIFETIME, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
        ini_set('session.use_strict_mode', '1');
        ini_set('session.gc_maxlifetime', (string) self::LIFETIME);
        session_start();
    }

    public static function startSession(array $user): void
    {
        self::openSession();
        session_regenerate_id(true);
        $_SESSION['uid'] = $user['id'];
        $_SESSION['exp'] = time() + self::LIFETIME;
        session_write_close(); // release the session file lock so parallel requests are not serialised
    }

    public static function endSession(): void
    {
        if (!isset($_COOKIE['sid'])) return;
        self::openSession();
        $_SESSION = [];
        session_destroy();
        setcookie('sid', '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
    }

    public static function currentUser(): ?array
    {
        if (!isset($_COOKIE['sid'])) return null;
        self::openSession();
        $uid = $_SESSION['uid'] ?? null;
        $exp = $_SESSION['exp'] ?? 0;
        session_write_close();
        if (!$uid || $exp < time()) return null;
        $u = Db::get('users', (string) $uid);
        return $u && ($u['active'] ?? null) !== false ? $u : null;
    }

    public static function require(): array
    {
        self::$user = self::currentUser() ?? fail(401, 'Not signed in');
        return self::$user;
    }

    public static function modules(?array $user = null): array
    {
        $user ??= self::$user;
        return self::$roles[$user['role'] ?? '']['modules'] ?? [];
    }

    public static function can(string ...$mods): bool
    {
        if ((self::$user['role'] ?? '') === 'admin') return true;
        return (bool) array_intersect($mods, self::modules());
    }

    /** Require access to at least one of the given apps. */
    public static function need(string ...$mods): void
    {
        if (!self::can(...$mods)) fail(403, 'Your role does not have access to this function');
    }

    public static function publicUser(array $u): array
    {
        return ['id' => $u['id'], 'name' => $u['name'] ?? null, 'email' => $u['email'] ?? null, 'role' => $u['role'] ?? null,
            'employee_id' => $u['employee_id'] ?? null, 'has_face' => !empty($u['face_descriptor']),
            'role_label' => self::$roles[$u['role'] ?? '']['label'] ?? null, 'modules' => self::modules($u)];
    }

    public static function hash(string $pw): string { return password_hash($pw, PASSWORD_DEFAULT); }
    public static function check($pw, $stored): bool { return is_string($stored) && $stored !== '' && password_verify((string) $pw, $stored); }

    /** Face login: euclidean distance between 128-d descriptors; match below 0.5 (face-api.js convention). */
    public static function matchFace($descriptor): ?array
    {
        if (!is_array($descriptor) || count($descriptor) !== 128) fail(400, 'Invalid face descriptor');
        $best = null;
        $bd = 0.0;
        foreach (Db::raw('SELECT id FROM `users` WHERE face_descriptor IS NOT NULL') as $r) {
            $u = Db::get('users', $r['id']);
            if (!is_array($u['face_descriptor'] ?? null) || ($u['active'] ?? null) === false) continue;
            $s = 0.0;
            foreach ($u['face_descriptor'] as $i => $v) $s += (($v ?? 0) - ($descriptor[$i] ?? 0)) ** 2;
            $d = sqrt($s);
            if ($d < 0.5 && ($best === null || $d < $bd)) { $best = $u; $bd = $d; }
        }
        return $best;
    }
}
