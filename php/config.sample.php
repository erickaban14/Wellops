<?php
// Copy to config.php and fill in. config.php must never be web-readable (see .htaccess) and is git-ignored.
return [
    'db' => [
        'host' => 'sqlXXX.infinityfree.com', // "MySQL host name" from the InfinityFree control panel
        'port' => 3306,
        'name' => 'if0_XXXXXXXX_prostars',
        'user' => 'if0_XXXXXXXX',
        'pass' => 'change-me',
    ],
    // Role picker on the login page without a password. Keep false for anything but a public demo.
    'demo_login' => true,
    // Password given to every seeded user by install.php (change them under Settings > Users afterwards).
    'seed_password' => 'ChangeMe-2026',
    // install.php refuses to run from the web unless ?key=<this value> is supplied. Use a long random string.
    'install_key' => 'change-me-to-a-long-random-string',
    // Show PHP error details in API responses (development only).
    'debug' => false,
];
