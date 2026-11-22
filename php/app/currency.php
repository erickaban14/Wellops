<?php
// One-time conversion of all stored amounts from US dollars to Omani rials (3 decimals = baisa).
// Used by install.php (the demo seed is generated in USD) and by convert-omr.php for an existing database.

const USD_TO_OMR = 0.3845;            // Central Bank of Oman peg: 1 OMR = 2.6008 USD
const OMR_SYMBOL = "\u{20C4}";        // official Omani rial sign (CBO, Nov 2025), Unicode U+20C4

/** Money keys inside JSON fields (RFQ/PO lines, MRP plan costs). */
const MONEY_JSON_KEY = '/^(amount|total|budget|price|unit_cost|day_rate|hourly_rate|daily_allowance|purchase_cost|labor|material|equipment)$/';

function omr_walk($v, float $rate)
{
    if (!is_array($v)) return $v;
    foreach ($v as $k => $x) {
        if (is_array($x)) $v[$k] = omr_walk($x, $rate);
        elseif ((is_int($x) || is_float($x)) && is_string($k) && preg_match(MONEY_JSON_KEY, $k)) $v[$k] = round($x * $rate, 3);
    }
    return $v;
}

/** Converts every money column and JSON price in the database and sets currency = OMR. Returns a log of what changed. */
function convert_to_omr(float $rate = USD_TO_OMR): array
{
    $log = [];
    Db::tx(function () use ($rate, &$log) {
        foreach (Db::$models as $t => $m) {
            $cols = array_keys(array_filter($m['fields'], fn($f) => !empty($f['money'])));
            if ($cols) {
                $set = implode(', ', array_map(fn($c) => "`$c` = ROUND(`$c` * ?, 3)", $cols));
                $n = Db::pdo()->prepare("UPDATE `$t` SET $set");
                $n->execute(array_fill(0, count($cols), $rate));
                $log[] = sprintf('%-20s %s (%d rows)', $t, implode(', ', $cols), $n->rowCount());
            }
            $json = array_keys(array_filter($m['fields'], fn($f) => ($f['type'] ?? '') === 'json'));
            foreach ($json as $c) {
                $changed = 0;
                foreach (Db::raw("SELECT id, `$c` AS v FROM `$t` WHERE `$c` IS NOT NULL AND `$c` <> ''") as $r) {
                    $old = json_decode((string) $r['v'], true);
                    $new = omr_walk($old, $rate);
                    if ($new !== $old) { Db::q("UPDATE `$t` SET `$c` = ? WHERE id = ?", [json_encode($new, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $r['id']]); $changed++; }
                }
                if ($changed) $log[] = sprintf('%-20s %s prices (%d rows)', $t, $c, $changed);
            }
        }
        foreach (['currency' => ['OMR', 'Currency code'], 'currency_symbol' => [OMR_SYMBOL, 'Symbol shown before amounts']] as $k => [$v, $desc]) {
            $row = Db::list('settings', ['key' => $k])[0] ?? null;
            $row ? Db::update('settings', $row['id'], ['value' => $v]) : Db::insert('settings', ['key' => $k, 'value' => $v, 'description' => $desc]);
        }
        $log[] = 'settings             currency = OMR, symbol = U+20C4';
    });
    return $log;
}
