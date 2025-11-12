<?php
/**
 * collect_frames.php — автоматический сборщик «весовых рамок» для Trans-Time.
 * Примеры использования:
 *   /collect_frames.php?src=https://example.com/page&token=SECRET
 *   /collect_frames.php?src=https://example.com/page1&src=https://example.com/page2&save=1&token=SECRET
 */

declare(strict_types=1);

// ============================= НАСТРОЙКИ ============================= //
const RUS_BBOX = [
    'minLon' => 19.0,
    'minLat' => 41.0,
    'maxLon' => 191.0,
    'maxLat' => 82.0,
];
const MAX_DEVIATION_M = 3000.0;
const ALLOW_HOSTS = ['example.com'];
const SAVE_PATH = __DIR__ . '/frames_ready.geojson';
const SECRET_TOKEN = 'SECRET';
// ==================================================================== //

// Подключаем config.php при наличии, чтобы достать YANDEX_API_KEY
if (file_exists(__DIR__ . '/config.php')) {
    require_once __DIR__ . '/config.php';
}

header('Access-Control-Allow-Origin: *');

/**
 * Завершает выполнение с JSON-ответом об ошибке.
 */
function respond_error(string $message, int $code = 400): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$token = (string)($_GET['token'] ?? '');
if ($token !== SECRET_TOKEN) {
    respond_error('forbidden', 403);
}

$srcParam = $_GET['src'] ?? [];
if (is_string($srcParam)) {
    $srcs = [$srcParam];
} elseif (is_array($srcParam)) {
    $srcs = array_filter(array_map('strval', $srcParam));
} else {
    $srcs = [];
}

if (!$srcs) {
    respond_error('no_sources_provided', 400);
}

$save = isset($_GET['save']) && (string)$_GET['save'] === '1';

$features = [];
$errors = [];
$stats = ['ok' => 0, 'warn' => 0, 'err' => 0];
$dedup = [];

foreach ($srcs as $url) {
    $url = trim($url);
    if ($url === '') {
        $errors[] = "empty_url";
        continue;
    }

    $host = parse_url($url, PHP_URL_HOST) ?? '';
    if ($host === '') {
        $errors[] = "invalid_url:{$url}";
        continue;
    }

    $host = strtolower($host);
    $allowed = false;
    foreach (ALLOW_HOSTS as $allowedHost) {
        if ($host === strtolower($allowedHost) || str_ends_with($host, '.' . strtolower($allowedHost))) {
            $allowed = true;
            break;
        }
    }
    if (!$allowed) {
        $errors[] = "blocked_host:{$host}";
        continue;
    }

    $html = fetch_url($url, $fetchErr);
    if ($html === null) {
        $errors[] = "fetch_failed:{$url}:{$fetchErr}";
        continue;
    }

    $rows = parse_rows_from_html($html, $url);
    if (!$rows) {
        $errors[] = "no_rows_found:{$url}";
        continue;
    }

    foreach ($rows as $row) {
        $name = $row['name'] ?? '';
        $address = $row['address'] ?? '';
        $comment = $row['comment'] ?? '';
        $rawCoords = $row['coords'] ?? null;

        $lat = null;
        $lon = null;
        if ($rawCoords) {
            foreach ($rawCoords as $pair) {
                [$candLat, $candLon] = $pair;
                [$normLon, $normLat] = normalize_lonlat($candLat, $candLon);
                $lat = $normLat;
                $lon = $normLon;
                if (in_russia($lat, $lon)) {
                    break;
                }
            }
        }

        $geocodeUsed = false;
        if ($lat === null || $lon === null) {
            if ($address !== '') {
                $geo = y_geocode_addr($address);
                if ($geo) {
                    $lat = $geo['lat'];
                    $lon = $geo['lon'];
                    $geocodeUsed = true;
                }
            }
        }

        if ($lat === null || $lon === null) {
            $stats['err']++;
            $errors[] = "no_coordinates:{$name}";
            continue;
        }

        $status = 'ok';
        if (!in_russia($lat, $lon)) {
            $status = 'err';
        }

        $delta = null;
        if ($status !== 'err') {
            $reverse = y_reverse($lon, $lat);
            if ($reverse) {
                $delta = haversine($lat, $lon, $reverse['lat'], $reverse['lon']);
                if ($delta > MAX_DEVIATION_M) {
                    $status = 'warn';
                }
            }
        }

        if ($status === 'ok') {
            $stats['ok']++;
        } elseif ($status === 'warn') {
            $stats['warn']++;
        } else {
            $stats['err']++;
        }

        if ($status === 'err' && !in_russia($lat, $lon)) {
            $errors[] = "outside_russia:{$lat},{$lon}";
        }

        $key = null;
        if ($lon !== null && $lat !== null) {
            $key = sprintf('coord_%0.6f_%0.6f', round($lon, 6), round($lat, 6));
        } else {
            $key = 'hash_' . md5($name . '|' . $address);
        }

        if (isset($dedup[$key])) {
            continue;
        }
        $dedup[$key] = true;

        $properties = [
            'name' => $name,
            'address' => $address,
            'comment' => $comment,
            'source' => $row['source'],
            'verified' => $status,
            'delta_m' => $delta,
            'geocoded' => $geocodeUsed,
        ];

        $feature = [
            'type' => 'Feature',
            'geometry' => [
                'type' => 'Point',
                'coordinates' => [$lon, $lat],
            ],
            'properties' => $properties,
        ];

        $features[] = $feature;
    }
}

$collection = [
    'type' => 'FeatureCollection',
    'features' => $features,
];

if ($save) {
    $json = json_encode($collection, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        respond_error('json_encode_failed', 500);
    }
    $written = @file_put_contents(SAVE_PATH, $json);
    if ($written === false) {
        respond_error('save_failed', 500);
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'saved' => 'ok',
        'file' => basename(SAVE_PATH),
        'count' => count($features),
        'ok' => $stats['ok'],
        'warn' => $stats['warn'],
        'err' => $stats['err'],
        'errors' => $errors,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

header('Content-Type: application/geo+json; charset=utf-8');
echo json_encode($collection, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
exit;

/**
 * Загружает URL через cURL.
 *
 * @return string|null Возвращает HTML или null при ошибке.
 */
function fetch_url(string $url, ?string &$error = null): ?string
{
    $ch = curl_init($url);
    if ($ch === false) {
        $error = 'curl_init_failed';
        return null;
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_USERAGENT => 'TransTime-Collector/1.0',
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);

    $data = curl_exec($ch);
    if ($data === false) {
        $error = 'curl_error:' . curl_error($ch);
        curl_close($ch);
        return null;
    }

    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code >= 400) {
        $error = 'http_' . $code;
        return null;
    }
    return $data;
}

/**
 * Извлекает строки с данными из HTML.
 *
 * @return array<int, array{name:string,address:string,comment:string,coords:array<int,array{0:float,1:float}>,source:string}>
 */
function parse_rows_from_html(string $html, string $sourceUrl): array
{
    $rows = [];

    $internalErrors = libxml_use_internal_errors(true);
    $doc = new DOMDocument();
    $loaded = $doc->loadHTML($html);
    libxml_clear_errors();
    libxml_use_internal_errors($internalErrors);
    if (!$loaded) {
        return $rows;
    }

    $xpath = new DOMXPath($doc);

    $tables = $xpath->query('//table');
    if ($tables !== false) {
        foreach ($tables as $table) {
            $trs = $table->getElementsByTagName('tr');
            foreach ($trs as $tr) {
                $cells = [];
                foreach ($tr->childNodes as $child) {
                    if ($child instanceof DOMElement && in_array(strtolower($child->tagName), ['td', 'th'], true)) {
                        $cells[] = trim(preg_replace('/\s+/u', ' ', $child->textContent ?? ''));
                    }
                }
                $cells = array_filter($cells, fn($v) => $v !== '');
                if (!$cells) {
                    continue;
                }

                $text = implode(' ', $cells);
                $coords = parse_coords_from_text($text);

                $name = $cells[0] ?? '';
                $address = '';
                $comment = '';

                if (count($cells) >= 2) {
                    $address = $cells[1];
                }
                if (count($cells) >= 3) {
                    $comment = implode('; ', array_slice($cells, 2));
                }

                if (preg_match('/адрес\s*[:\-]/iu', $text) && preg_match('/адрес\s*[:\-]\s*(.+?)(?:;|$)/iu', $text, $m)) {
                    $address = trim($m[1]);
                }
                if (preg_match('/коммент|описание/iu', $text) && preg_match('/(?:коммент|описание)\s*[:\-]\s*(.+)$/iu', $text, $m)) {
                    $comment = trim($m[1]);
                }

                $rows[] = [
                    'name' => $name,
                    'address' => $address,
                    'comment' => $comment,
                    'coords' => $coords,
                    'source' => $sourceUrl,
                ];
            }
        }
    }

    $blockTexts = [];
    foreach (['//p', '//li', '//div'] as $query) {
        $nodes = $xpath->query($query);
        if ($nodes === false) {
            continue;
        }
        foreach ($nodes as $node) {
            $text = trim(preg_replace('/\s+/u', ' ', $node->textContent ?? ''));
            if ($text !== '' && mb_strlen($text) > 5) {
                $blockTexts[] = $text;
            }
        }
    }

    foreach ($blockTexts as $text) {
        $coords = parse_coords_from_text($text);
        if (!$coords) {
            continue;
        }

        $name = '';
        $address = '';
        $comment = '';

        if (preg_match('/^(.*?)\s*(?:\-|—|:)\s*(.+)$/u', $text, $m)) {
            $name = trim($m[1]);
            $rest = trim($m[2]);
        } else {
            $rest = $text;
        }

        if (preg_match('/адрес\s*[:\-]\s*(.+?)(?:;|$)/iu', $rest, $m)) {
            $address = trim($m[1]);
        }

        if ($address === '' && preg_match('/ул\.|улица|просп|шоссе|город/iu', $rest)) {
            $address = $rest;
        }

        if (preg_match('/коммент|описание/iu', $rest) && preg_match('/(?:коммент|описание)\s*[:\-]\s*(.+)$/iu', $rest, $m)) {
            $comment = trim($m[1]);
        }

        $rows[] = [
            'name' => $name !== '' ? $name : $text,
            'address' => $address,
            'comment' => $comment,
            'coords' => $coords,
            'source' => $sourceUrl,
        ];
    }

    return $rows;
}

/**
 * Извлекает координаты из текста.
 *
 * @return array<int, array{0:float,1:float}>
 */
function parse_coords_from_text(string $text): array
{
    $results = [];

    if (preg_match_all('/(-?\d{1,3}(?:\.\d+)?)[\s,;]+(-?\d{1,3}(?:\.\d+)?)/u', $text, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $match) {
            $lat = (float)$match[1];
            $lon = (float)$match[2];
            if (abs($lat) <= 90 && abs($lon) <= 190) {
                $results[] = [$lat, $lon];
            }
        }
    }

    $patternDms = "/(\\d{1,3})[°º]\\s*(\\d{1,2})[′’']?\\s*(\\d{1,2}(?:\\.\\d+)?)?[″\"]?\\s*([NSEWСВЮЗ]?)[\\s,;]+(\\d{1,3})[°º]\\s*(\\d{1,2})[′’']?\\s*(\\d{1,2}(?:\\.\\d+)?)?[″\"]?\\s*([NSEWСВЮЗ]?)/u";
    if (preg_match_all($patternDms, $text, $dmsMatches, PREG_SET_ORDER)) {
        foreach ($dmsMatches as $match) {
            $lat = dms_to_dec((int)$match[1], (int)$match[2], isset($match[3]) ? (float)$match[3] : 0.0, $match[4] ?? 'N');
            $lon = dms_to_dec((int)$match[5], (int)$match[6], isset($match[7]) ? (float)$match[7] : 0.0, $match[8] ?? 'E');
            $results[] = [$lat, $lon];
        }
    }

    return $results;
}

/**
 * Преобразует DMS в десятичные градусы.
 */
function dms_to_dec(int $deg, int $min, float $sec, string $hemisphere): float
{
    $sign = 1.0;
    $hem = strtoupper(trim($hemisphere));
    if (in_array($hem, ['S', 'W', 'Ю', 'З'], true)) {
        $sign = -1.0;
    }
    $dec = $deg + $min / 60.0 + $sec / 3600.0;
    return $dec * $sign;
}

/**
 * Нормализует координаты в порядке lon, lat. Пытается угадать порядок.
 *
 * @return array{0:float,1:float}
 */
function normalize_lonlat(float $latCandidate, float $lonCandidate): array
{
    $lat = $latCandidate;
    $lon = $lonCandidate;
    if (!in_russia($lat, $lon) && in_russia($lonCandidate, $latCandidate)) {
        $lat = $lonCandidate;
        $lon = $latCandidate;
    }
    return [$lon, $lat];
}

/**
 * Проверяет, лежат ли координаты в пределах РФ.
 */
function in_russia(float $lat, float $lon): bool
{
    if ($lat < RUS_BBOX['minLat'] || $lat > RUS_BBOX['maxLat']) {
        return false;
    }
    if ($lon < RUS_BBOX['minLon']) {
        return false;
    }
    if ($lon > RUS_BBOX['maxLon']) {
        return false;
    }
    return true;
}

/**
 * Геокодирует адрес через API Яндекс-Карт.
 *
 * @return array{lat:float,lon:float}|null
 */
function y_geocode_addr(string $address): ?array
{
    $key = get_yandex_key();
    if ($key === null) {
        return null;
    }
    $query = http_build_query([
        'apikey' => $key,
        'format' => 'json',
        'lang' => 'ru_RU',
        'geocode' => $address,
        'results' => 1,
    ]);
    $url = 'https://geocode-maps.yandex.ru/1.x/?' . $query;
    $json = fetch_url($url, $err);
    if ($json === null) {
        return null;
    }
    $data = json_decode($json, true);
    if (!is_array($data)) {
        return null;
    }
    $pos = $data['response']['GeoObjectCollection']['featureMember'][0]['GeoObject']['Point']['pos'] ?? null;
    if (!is_string($pos)) {
        return null;
    }
    $parts = preg_split('/\s+/', trim($pos));
    if (!$parts || count($parts) < 2) {
        return null;
    }
    $lon = (float)$parts[0];
    $lat = (float)$parts[1];
    return ['lat' => $lat, 'lon' => $lon];
}

/**
 * Обратное геокодирование.
 *
 * @return array{lat:float,lon:float}|null
 */
function y_reverse(float $lon, float $lat): ?array
{
    $key = get_yandex_key();
    if ($key === null) {
        return null;
    }
    $query = http_build_query([
        'apikey' => $key,
        'format' => 'json',
        'lang' => 'ru_RU',
        'geocode' => $lon . ',' . $lat,
        'kind' => 'house',
        'results' => 1,
    ]);
    $url = 'https://geocode-maps.yandex.ru/1.x/?' . $query;
    $json = fetch_url($url, $err);
    if ($json === null) {
        return null;
    }
    $data = json_decode($json, true);
    if (!is_array($data)) {
        return null;
    }
    $pos = $data['response']['GeoObjectCollection']['featureMember'][0]['GeoObject']['Point']['pos'] ?? null;
    if (!is_string($pos)) {
        return null;
    }
    $parts = preg_split('/\s+/', trim($pos));
    if (!$parts || count($parts) < 2) {
        return null;
    }
    $resLon = (float)$parts[0];
    $resLat = (float)$parts[1];
    return ['lat' => $resLat, 'lon' => $resLon];
}

/**
 * Получает ключ Яндекс-Карт.
 */
function get_yandex_key(): ?string
{
    $envKey = getenv('YANDEX_API_KEY');
    if (is_string($envKey) && $envKey !== '') {
        return $envKey;
    }
    if (defined('YANDEX_API_KEY') && is_string(YANDEX_API_KEY) && YANDEX_API_KEY !== '') {
        return YANDEX_API_KEY;
    }
    return null;
}

/**
 * Вычисляет расстояние по формуле гаверсина.
 */
function haversine(float $lat1, float $lon1, float $lat2, float $lon2): float
{
    $earthRadius = 6371000.0;
    $lat1Rad = deg2rad($lat1);
    $lat2Rad = deg2rad($lat2);
    $deltaLat = deg2rad($lat2 - $lat1);
    $deltaLon = deg2rad($lon2 - $lon1);

    $a = sin($deltaLat / 2) ** 2 + cos($lat1Rad) * cos($lat2Rad) * sin($deltaLon / 2) ** 2;
    $c = 2 * atan2(sqrt($a), sqrt(1 - $a));

    return $earthRadius * $c;
}
?>
