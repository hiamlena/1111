<?php
// Исправляет ошибку 404 для favicon.ico и добавляет расширенную поддержку наборов favicon
$base64 = 'AAABAAIAEBAAAAAAIADIAQAAJgAAACAgAAAAACAAZQIAAO4BAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAGPSURBVHicpZM/TxRRFMV/9/2Zt7uzliRgBb3xQ9Baa2tp6Qcw4XtYU0lpRWOIhoLEaIAYTQTUgsQAG1mzG4KzM+9SzOzu7AzS8JJJ7sx977xzzj0jS0+2lHssc5/DAK71wcqdB4qoaI3zAoAqDIb/iAoIUNsoUvYfpI7EmRmImzaLCL1gefn0MSGxrZtVFRHhzbtfHJ+O6CSWqDpnEKPSCZZXzx8h8n8ZH78N+PJjSDdY0KaJCtkkzl7zYq4hm0S0kkkNf8ZABCZF5P3+Gd5Z1h72WV1OuRheM77KWV1J+TvKuBhe4+3cAzM1zxphfJXzbOMD6y+22dw+AWDn8xmv3x4hInz6/oe9rwP6PUesEBYkiEC/6/GpJ/FlyzshVLUzgrOyMMZWkGLU6ilnXjRqbeT21iSqQkgM1gi94Ai+rNOuo5n7VhJVIfGGk9MRu4fnHBxf8vP3mN3Dc/aPLnFmUYLc9jOJlGPL8oizBiOQ5RFrhE4jZC0GdRYhsdVtWqZTmbl/J8AURGubteletW4A8Puwh+62XzcAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6evQAAAIsSURBVHic7Ze/b9NQEMc/9/xeYqdO24AoA2yIAf4RJFjYkNjYGFmYYajEzsTSAbHBxFoxUboglrQM7CCQAhISLCTxe8fgOriKa+cHUpbceHL8Pv7e9+5e5MKtl8oKw6zy8DXAGgDANj0gstwB2tBjjQBZpizTp8aAqfmKWgAR2EodIoIC84ihqogIw7FnOApnKlkJIALjTNlOWxw+u0GaWOYl8EGJjPD01Sce7fXZ6SVkPswGUAbZSh2ddmOlKiInjltRrQ9m80ArN9M8hsy8YiMhNLhwpi4oDp4HoPy7pQAyr2Q+lBQQbHT6zSEoXhUXmel8WEIBEeh1W02MGCOYCocaI2xuuNoyVAKoghH4M/LsPj+m7fIvCwHidsT921dpu2ji9IP+gHdHAx7evY6NDD4oRoTD4wGv336m23GEM5Q4UwFjhOEo8HivP5HfZ8r2Zot7N6/QdhHhBGD//Vd29454cOcaNsqld9bw5sM39g++cOnyJqPMzwcA+aE7vRiQyWzodd2UudKO4/y5ZKoIaeJwi5SgHJlXQBEpDDn9shCUccWQmcWEK9+Ga4CVAyyyZSbTMfP5mi16PM/JVP6/ApSnoz0ZvRuJRcnbrpxPE7v8MiqiajqWJ6E1wpMXH7GRTPKHx9/ZiG2tEjLvPyNV+Pl7mO94ARQ6saXTjvjxa/jv4qKQxJY0rldhoRIU07GIoEoIysVecurZIl8XC5uQiqtq1ZWrKVbehmuAv2aG+UnApMLQAAAAAElFTkSuQmCC';
$data = base64_decode($base64, true);
if ($data === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Favicon decode error';
    return;
}
$etag = '"tt-favicon-'.substr(sha1($base64), 0, 16).'"';
header('Content-Type: image/vnd.microsoft.icon');
header('Cache-Control: public, max-age=86400, immutable');
header('ETag: '.$etag);
if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && trim($_SERVER['HTTP_IF_NONE_MATCH']) === $etag) {
    http_response_code(304);
    header('Content-Length: 0');
    return;
}
$length = strlen($data);
header('Content-Length: '.$length);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    return;
}
echo $data;
