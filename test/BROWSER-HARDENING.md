# Browser- und Schulnetz-Härtetest

Stand dieser Evidenz: 20. August 2026. Dieses Dokument beschreibt den
reproduzierbaren Freigabetest für Download, Cache, Browserneustart, echte
Offline-Inferenz und Cache-Löschung. Die derzeitigen PASS-Nachweise gelten nur
für das kompakte mDeBERTa-Modell mit ONNX Runtime/WASM. Das Quality-Modell wird
weiter unten bewusst getrennt behandelt.

Ein PASS auf einem Browser ist keine pauschale Freigabe für andere
Betriebssysteme, Browsermarken, Geräte oder Einbettungskontexte. Insbesondere ist
Playwright WebKit unter Windows kein Safari- oder iOS-Nachweis.

## Verbindliches Akzeptanzkriterium

Ein Browser/OS-Paar erhält nur dann einen PASS, wenn ein einziger Lauf alle
folgenden Punkte erfüllt:

1. Der Runner startet mit einem frischen persistenten Browserprofil. Vor dem
   Cold-Run meldet die Cache-Prüfung `cached=false`.
2. Modell und exakt passende ONNX-Runtime werden aus dem Netz geladen. Danach
   sind alle sechs Kompaktmodell-Einträge und genau zwei Runtime-Einträge
   (`.mjs` und `.wasm`) vorhanden.
3. Während Vorbereitung und echter NLI-Inferenz läuft ein 50-ms-UI-Heartbeat.
   Kein gemessener Abstand darf 1.000 ms überschreiten; das Testergebnis muss
   zusätzlich `passed=true` melden.
4. Der Browserkontext und damit der zugehörige Browserprozess werden
   geschlossen.
5. Derselbe Browser wird mit exakt demselben persistenten Profil neu gestartet.
   Noch vor dem Seitenaufruf sperrt der Runner alle Requests, deren Origin nicht
   der lokale Testserver ist.
6. Nach dem Neustart muss die Cache-Prüfung `cached=true`, die Vorbereitung
   `loadSource=cache` und eine zweite echte Inferenz `passed=true` melden.
7. Im gesamten Warm-/Offline-Lauf darf kein externer Request auch nur versucht
   werden (`externalAttempts=[]`). Unbehandelte `pageerror`-Ereignisse sind
   ebenfalls ein Fehler.
8. Bei weiterhin gesperrtem externem Netz wird `clearCache()` ausgeführt. Danach
   dürfen weder Modell- noch versionierte Runtime-Einträge übrig sein.

Kurzform: **Cold-Download → UI-Heartbeat → echte Inferenz → Browser schließen → gleiches
Profil → externes Netz vollständig sperren → Cache-Load → echte Inferenz →
null externe Requests → Offline-Clear.** Ein Smoke-Test, ein bloßer Cache-Hit
oder erfolgreiches Laden ohne Inferenz reicht nicht aus.

## Runner reproduzieren

Der Runner verwendet `test/browser-cache-hardening.html`, startet einen lokalen
HTTP-Server auf `127.0.0.1`, legt pro Browser ein separates temporäres Profil an
und schreibt einen JSON-Report nach `test-results/`. Das Verzeichnis ist bewusst
von Git ausgeschlossen. Vor jedem Lauf muss das aktuelle Bundle gebaut werden,
da die Fixture `dist/index.js` prüft.

PowerShell:

```powershell
npm ci
npm run build
npm run test:browser-hardening
```

Gezielte, besser auswertbare Läufe:

```powershell
$env:LIA_LLM_HARDENING_BROWSERS = 'edge,chrome,chromium'
npm run test:browser-hardening

$env:LIA_LLM_HARDENING_BROWSERS = 'firefox'
$env:LIA_LLM_HARDENING_TIMEOUT_MS = '1200000'
npm run test:browser-hardening

$env:LIA_LLM_HARDENING_BROWSERS = 'webkit'
$env:LIA_LLM_HARDENING_TIMEOUT_MS = '1200000'
npm run test:browser-hardening
```

POSIX-Shell, beispielsweise auf macOS oder Linux:

```sh
npm ci
npm run build
LIA_LLM_HARDENING_BROWSERS=chrome npm run test:browser-hardening
LIA_LLM_HARDENING_BROWSERS=firefox LIA_LLM_HARDENING_TIMEOUT_MS=1200000 npm run test:browser-hardening
LIA_LLM_HARDENING_BROWSERS=webkit LIA_LLM_HARDENING_TIMEOUT_MS=1200000 npm run test:browser-hardening
```

Unterstützte Umgebungsvariablen:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `LIA_LLM_HARDENING_BROWSERS` | `edge,chrome,chromium,firefox,webkit` | Kommagetrennte Kandidaten in Ausführungsreihenfolge |
| `LIA_LLM_HARDENING_TIMEOUT_MS` | `600000` | Zeitlimit jeweils für Cold- und Offline-Browserphase |
| `LIA_LLM_KEEP_PROFILES` | nicht gesetzt | Mit `1` bleiben Diagnoseprofile im OS-Tempverzeichnis unter `lia-llm-browser-hardening-*` erhalten |

`edge` und `chrome` verwenden die installierten Markenbrowser über die
Playwright-Channels `msedge` und `chrome`. `chromium`, `firefox` und `webkit`
benötigen die zur installierten `playwright-core`-Version passenden
Engine-Binaries. Ein fehlendes Binary wird als `unavailable` protokolliert.

Der Report heißt
`test-results/browser-hardening-<ISO-Zeitstempel>.json`. Für eine Freigabe muss
jeder ausgewählte Eintrag ausdrücklich `status` gleich `passed` haben. Der
Prozesscode allein genügt nicht, weil `unavailable` kein bestandener Test ist. Ein Lauf lädt
pro frischem Browserprofil rund 379 MB; mehrere Browser sollten daher nicht
unbeabsichtigt über eine volumenbegrenzte Verbindung getestet werden.

Nach einem Diagnose-Lauf können die Variablen in PowerShell so entfernt werden:

```powershell
Remove-Item Env:LIA_LLM_HARDENING_BROWSERS -ErrorAction SilentlyContinue
Remove-Item Env:LIA_LLM_HARDENING_TIMEOUT_MS -ErrorAction SilentlyContinue
Remove-Item Env:LIA_LLM_KEEP_PROFILES -ErrorAction SilentlyContinue
```

## Evidenzklassen

| Klasse | Bedeutung | Was damit nicht bewiesen ist |
| --- | --- | --- |
| A – realer Markenbrowser | Tatsächlich installierter Edge- oder Chrome-Binary auf dem genannten realen Betriebssystem; der Runner arbeitet headless mit einem echten persistenten Profil. | Andere OS-Versionen, mobile Wrapper, GUI-/LMS-Sonderverhalten und andere Browsermarken |
| B – Engine-Build/Simulation | Echter Playwright-Engine-Build für Chromium, Firefox oder WebKit. Geeignet für API-, Cache- und Inferenzkompatibilität der Engine. | Eine Marken- oder Gerätezertifizierung; insbesondere ist Windows-WebKit weder macOS Safari noch iOS Safari. |
| C – Realgerät erforderlich | Originales OS mit dem tatsächlichen Markenbrowser, dauerhaftem Profil und der vorgesehenen Einbettung. | Ohne einen solchen Lauf gibt es keinen PASS, auch wenn dieselbe Engine anderswo bestanden hat. |

Eine VM mit originalem OS und originalem Markenbrowser kann für Desktoptests als
Real-OS-Nachweis dienen. iOS-/iPadOS- und Android-Freigaben benötigen ein echtes
Gerät oder eine Device-Farm, die Browserprofil, Neustart, Netzwerkblockade und
Cache-Löschung real abbildet.

## Derzeit belegte Ergebnisse

Testhost: Windows 10 Pro, Version `10.0.19045`, x64, Node.js `v24.14.0`.

| Browser | Klasse | Version | Reportstart (UTC) | Cold | Neustart/Offline | gemessene Origin-Nutzung | Ergebnis |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Microsoft Edge | A | `151.0.4129.93` | `2026-08-20T13:15:41.702Z` | 173.631 ms | 4.804 ms | 378.621.184 B | PASS |
| Google Chrome | A | `151.0.7922.138` | `2026-08-17T12:07:00.113Z` | 133.491 ms | 3.671 ms | 378.621.184 B | Altstand; Heartbeat offen |
| Playwright Chromium | B | `151.0.7922.34` | `2026-08-17T12:07:00.113Z` | 129.093 ms | 3.446 ms | 378.621.184 B | Altstand; Heartbeat offen |
| Playwright Firefox | B | `153.0` | `2026-08-17T13:01:21.039Z` | 123.963 ms | 17.466 ms | 350.504.241 B | Altstand; Heartbeat offen |
| Playwright WebKit | B | `26.5` | `2026-08-17T13:06:25.841Z` | 120.479 ms bis Timeout | nicht erreicht | kein vollständiger Modellcache | FAIL |

Der aktuelle Edge-Lauf belegt unter der dokumentierten Worker-/WASM-CSP
zusätzlich den neuen UI-Heartbeat: Die größten Abstände betrugen 543 ms beim
Cold-Preload, 68 ms bei der Cold-Inferenz, 529 ms beim Offline-Preload und 69 ms
bei der Offline-Inferenz. Er belegt außerdem
`cached=false → cached=true`, sechs Transformers-Cacheeinträge, zwei geprüfte
Runtime-Dateien, `loadSource=cache`, null externe Warmstart-Versuche und die
anschließende Löschung von acht Einträgen. Die drei älteren erfolgreichen Läufe
belegen dieselben Cache- und Inferenzkriterien, wurden aber vor Einführung des
Heartbeats aufgezeichnet und müssen für eine aktuelle UI-Freigabe wiederholt
werden. Edge, Chrome und Chromium meldeten
378.621.184 B Origin-Nutzung bei 11.116.039.424 B Quota. Firefox meldete
350.504.241 B bei 10.737.418.240 B Quota. `navigator.storage.persisted()` war in
allen vier PASS-Profilen `false`.

Die zugehörigen lokalen Reports sind:

- `test-results/browser-hardening-2026-08-17T11-37-16-096Z.json`
- `test-results/browser-hardening-2026-08-17T12-07-00-114Z.json`
- `test-results/browser-hardening-2026-08-17T13-01-21-046Z.json`
- `test-results/browser-hardening-2026-08-20T13-15-41-703Z.json`

### Behobener Firefox-Blocker

Der frühere Firefox-Timeout war kein Modell- oder CacheStorage-Nachweis gegen
Firefox. Die Vorbereitung wartete synchron auf `navigator.storage.persist()`;
dieser Browseraufruf konnte im Playwright-Firefox-Profil ohne Ende anhängig
bleiben und damit den eigentlichen Download blockieren. Die Persistenzanfrage
läuft jetzt im Hintergrund als Best-Effort-Versuch. Weder ihr Ergebnis noch ein
ausbleibender Abschluss blockiert Modellladen oder Inferenz.

Zusätzlich prüfen die Standard-Kompakt-Registry und der Quality-Cache-Probe nur
bekannte Cache-Schlüssel per `Cache.match`. Diese Prüfungen sind netzfrei und
starten insbesondere bei einem fehlenden Quality-Cache keinen Download. Der
entsprechende Unitstand ist durch die laufende Standardtestsuite abgedeckt.

### WebKit-Engine: FAIL, keine Safari-Zertifizierung

Playwright WebKit 26.5 ist weiterhin nicht freigegeben. Ein 300-Sekunden-Lauf
erreichte nur ungefähr 4,95 Prozent des Modellartefakts und wiederholte
Teil-Downloads. Der finale strukturierte Lauf gegen den letzten Build ist
`test-results/browser-hardening-2026-08-17T13-06-25-872Z.json` und zeigt:

- Cache-Info wurde abgeschlossen und die Modellvorbereitung gestartet;
  Metadaten, Konfiguration und Tokenizer wurden vollständig geladen.
- Beim ONNX-Modell folgten wiederholte Retries.
- Vier `pageerror`-Ereignisse meldeten `Failed writing data to the file system`.
- `huggingface.co` beantwortete alle 14 Requests (`200`×2, `206`×2,
  `302`×6, `307`×4). Zum CDN gingen sechs Requests, aber nur zwei Antworten
  ein (`200`×1, `206`×1); danach folgten Retry und Timeout. Der Report enthält
  neun deduplizierte externe URLs.
- Ein vollständiger Modellcache, Cold-Inferenz, Neustart und Offline-Inferenz
  wurden nicht erreicht.

Das ist ein reproduzierbarer FAIL des Playwright-WebKit-Builds auf dem
Windows-Testhost. Er ist weder eine Safari-Zertifizierung noch ein belastbarer
Safari-/macOS- oder Safari-/iOS-Funktionsnachweis; diese Kombinationen bleiben
Klasse C.

Ein separater finaler WebKit-UI/WASM-Smoke ist bestanden. Dieser kleine Smoke
belegt nur die dabei geprüften UI- und lokalen WASM-Grundfunktionen. Er lädt
keinen vollständigen Modellcache, schließt und öffnet kein persistentes Profil
für eine Offline-Inferenz und erfüllt deshalb ausdrücklich nicht das
Härtetest-Akzeptanzkriterium.

Die noch erforderliche Realplattform-Matrix lautet:

| Plattform | Noch erforderliche Markenbrowser |
| --- | --- |
| Windows 10 | Firefox 153 ist als Playwright-Engine (Klasse B) belegt; der echte Markenbrowser bleibt ebenso wie neuere Edge-/Chrome-Versionen separat zu prüfen |
| Windows 11 | Edge, Chrome, Firefox und gegebenenfalls ein separat verteiltes Chromium |
| macOS | Safari, Chrome, Firefox und Edge |
| iOS/iPadOS | Safari sowie die installierten Chrome-, Firefox- und Edge-Apps; trotz gemeinsamer WebKit-Basis getrennt testen |
| Android | Chrome, Firefox und Edge; gegebenenfalls das konkret eingesetzte Chromium/WebView |

## Schulnetz-Allowlist

Ein Cold-Download benötigt nicht nur die im Quelltext sichtbare Startdomain.
Redirect-Ziele, signierte Objekt-URLs und die LiaScript-PWA-Infrastruktur müssen
ebenfalls erreichbar sein. Die robuste Host-Allowlist ist:

| Host/Pattern | Zweck |
| --- | --- |
| `https://liascript.github.io` | LiaScript-Viewer/PWA, sofern der Kurs darüber geöffnet wird |
| `https://storage.googleapis.com` | vom aktuellen LiaScript-Service-Worker importiertes Workbox 7.4.0 |
| `https://raw.githubusercontent.com` | Kurs/Template-Bundle, gepinnte ONNX-Runtime und gepinnte WebLLM-Modellbibliothek |
| `https://huggingface.co` | Modellauflösung und erster Redirect |
| `https://*.huggingface.co` | API-/Cache- und mögliche LFS-Redirectziele, darunter `/api/resolve-cache/...` |
| `https://*.hf.co` | signierte Modellobjekt-CDNs; aktuell beobachtet wurde `us.aws.cdn.hf.co` |

Nur `github.com` freizugeben reicht nicht für
`raw.githubusercontent.com`. Ebenso darf eine Regel nicht allein auf den heute
beobachteten US-CDN festgelegt werden; Hugging Face kann das regionale oder
technische Redirect-Ziel ändern. DNS-Filter, TLS-Inspection und URL-Filter müssen
lange signierte Querystrings unverändert durchlassen.

Für einen erfolgreichen Cold-Lauf muss das Gateway mindestens Folgendes
zulassen beziehungsweise erhalten:

- HTTPS-`GET`, Redirects mit `302` und `307` sowie Antworten mit `200` und `206`;
- den Request-Header `Range` und bei Teilantworten eine korrekte
  `Content-Range`-Semantik;
- `Content-Length`, `Content-Encoding`, `Accept-Ranges` und `ETag`, ohne Bytes
  durch Virenscanner, Fehlerseiten oder transparente Rekodierung zu verändern;
- CORS mit `Access-Control-Allow-Origin` für die Kurs-/Viewer-Origin und bei
  Range-Antworten browserseitig lesbare `Content-Range`-/`Content-Length`-Header;
- beide Hugging-Face-Pfadformen `/resolve/...` und `/api/resolve-cache/...` sowie
  deren vollständige Redirect-Kette.

Die für das Modell relevanten `.bin`-, `.onnx`- und `.wasm`-Requests werden in
Bereichen von höchstens 8.388.608 B angefordert. Pro Bereich gelten 45 Sekunden
Stillstands-Timeout und insgesamt vier Versuche mit kurzen Wartezeiten. Für die
Proxybehandlung gelten drei klar verschiedene Fälle:

1. Liefert der Server ab dem ersten Request gültiges `206` mit lesbarem,
   passendem `Content-Range` und ohne nicht-identische `Content-Encoding`, wird
   segmentiert weitergeladen.
2. Entfernt der Server `Range` von Anfang an konsistent und liefert auf den
   ersten Request ein vollständiges `200`, akzeptiert der Downloader den
   Vollabruf. Dann muss das Objektlimit die komplette Datei erlauben.
3. Beginnt der Server mit `206`, liefert aber für einen späteren Bereich `200`,
   eine andere Gesamtlänge oder einen falschen Bereich, bricht der Downloader
   absichtlich ab. Ein solcher Proxy ist nicht kompatibel.

Beim Audit lieferten Raw-GitHub-Range-Requests in Chromium, Firefox und WebKit
zwar `206`; `Content-Range` war für JavaScript dort aber nicht CORS-exponiert.
Der Downloader verwirft deshalb die erste Teilantwort und fällt für die Raw-
Runtime auf einen vollständigen GET zurück. Ein expliziter Raw-GitHub-OPTIONS-
Preflight mit `Range` antwortete `403`; der einzelne Range-Header funktionierte
in den genannten Engines ohne Preflight. Schul-Gateways dürfen diese normale
safelisted Range-Anfrage daher nicht künstlich in einen obligatorischen
Preflight umwandeln. Beim Hugging-Face-CDN war `Content-Range` dagegen lesbar und
der segmentierte Download funktionierte.

## Objektgrößen und Integrität

Diese Grenzen sind für Proxy-, DLP- und Download-Limits relevant:

| Artefakt | Exakte/konfigurierte Größe | Netzbedingung |
| --- | ---: | --- |
| Segment eines chunkbaren Artefakts | höchstens 8.388.608 B | wenn Range korrekt funktioniert |
| Kompaktmodell `tokenizer.json` | 16.316.151 B | JSON wird vollständig geladen |
| ONNX-Runtime `.mjs` | 47.389 B | vollständiger Raw-GitHub-GET |
| ONNX-Runtime `.wasm` | 23.567.050 B | wegen fehlender Raw-CORS-Exposition derzeit Vollabruf |
| Kompaktmodell `model_quantized.onnx` | 338.679.132 B | größtes Kompaktobjekt bei entferntem Range |
| Gesamtschätzung Kompaktmodell plus Runtime | 378.614.439 B | erforderlicher freier Origin-Speicher zuzüglich Browser-Overhead |
| größter beobachteter Qwen-Shard | 194.478.080 B | Quality-Modell bei entferntem Range |

Damit reicht ein pauschales 8-MiB-Objektlimit selbst bei funktionierendem Range
nicht: JSON und die Raw-Runtime bleiben Vollabrufe. Wird Range vollständig
entfernt, muss der Proxy für das Kompaktmodell mindestens ein Objekt mit
338.679.132 B durchlassen.

Die Runtime-Quelle ist auf Commit
`0838e25f4da7ec8267637966ef747ef568517748` gepinnt. Der Live-Raw-GitHub-Abgleich
am 17. August 2026 war bytegleich mit `dist/`:

| Datei | Bytes | SHA-256 |
| --- | ---: | --- |
| `ort-wasm-simd-threaded.asyncify.mjs` | 47.389 | `5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9` |
| `ort-wasm-simd-threaded.asyncify.wasm` | 23.567.050 | `e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786` |

Der Client prüft Länge, Struktur und SHA-256, bevor diese Dateien dauerhaft in
den Runtime-Cache gelangen. Eine durch Filtersoftware ersetzte oder veränderte
Antwort wird daher mit Absicht abgelehnt.

## CSP und Einbettung

Eine CSP muss mit der bestehenden LiaScript-/Kurs-CSP zusammengeführt werden;
die folgenden Direktiven sind nur die modellrelevante Basis, keine vollständige
Site-Policy:

```text
connect-src 'self' https://liascript.github.io https://raw.githubusercontent.com https://storage.googleapis.com https://huggingface.co https://*.huggingface.co https://*.hf.co;
worker-src 'self' blob:;
script-src 'self' blob: 'wasm-unsafe-eval' https://liascript.github.io https://raw.githubusercontent.com https://storage.googleapis.com;
```

Falls ein Zielbrowser `'wasm-unsafe-eval'` nicht versteht, darf
`'unsafe-eval'` nur nach einem konkreten Test und einer Sicherheitsabwägung als
Fallback ergänzt werden. Die tatsächliche Viewer-/LMS-Policy kann außerdem
weitere LiaScript-Abhängigkeiten benötigen.

Der lokale Härtetest sendet selbst eine CSP mit `worker-src 'self' blob:`,
`script-src ... blob: 'wasm-unsafe-eval'` und den benötigten `connect-src`-Zielen.
Nur für das Inline-Testskript ergänzt die Fixture `'unsafe-inline'`; das ist
keine Empfehlung für die produktive Kurs-CSP.

Der Modellcache liegt in CacheStorage der aktuellen Origin, des Browserprofils
und gegebenenfalls der Storage-Partition. In einem `sandbox`-Iframe muss
mindestens `allow-same-origin` vorhanden sein; eine opaque Origin kann
CacheStorage unbenutzbar machen. Tracking Prevention kann Speicher in
Drittanbieter-Iframes partitionieren oder verweigern. Deshalb muss ein
LMS-Test im echten Einbettungskontext erfolgen, nicht nur als Top-Level-Seite.

Der LiaScript-Service-Worker und der Modellcache sind getrennte Schichten. Das
Template registriert keinen eigenen Service Worker und benötigt keinen Service
Worker für CacheStorage. Ein fehlerhaftes oder blockiertes PWA-Workbox-Skript
kann trotzdem den Viewer-Offlinepfad beeinträchtigen und muss separat getestet
werden.

## Persistenz-, Quota- und Privatmodus-Risiken

- CacheStorage ist origin-, profil- und partitionsgebunden. Ein anderer Host,
  Port, Browserkanal, Profilcontainer oder Einbettungskontext ist kein Warmstart
  desselben Caches.
- `navigator.storage.persist()` ist nur eine nicht blockierende
  Best-Effort-Bitte. Alle vier bisherigen PASS-Profile meldeten trotz
  erfolgreichem Neustart `persisted=false`; der Browser darf Daten unter
  Speicherdruck später verwerfen.
- Für das Kompaktmodell wurden je nach Engine 350.504.241 bis 378.621.184 B
  tatsächliche Origin-Nutzung gemessen. Vor dem Cold-Lauf muss mindestens die
  gesamte Artefaktmenge plus Browser-Overhead frei sein. Eine große nominelle
  Quota ist keine Persistenzgarantie.
- Privater/Inkognito-Modus ist erwartbar flüchtig. Ein Cache-Hit innerhalb
  derselben privaten Sitzung ist kein Nachweis für Persistenz nach Schließen des
  letzten privaten Fensters und darf nicht als regulärer PASS berichtet werden.
- Gelöschte Website-Daten, automatische Speicherbereinigung und
  Profilverwaltung durch die Schule können den Cache entfernen. Solche Policies
  müssen einen echten Browserneustart und gegebenenfalls einen Neustart des
  Geräts im Testplan enthalten.
- Das Kompaktmodell und die Runtime verwenden CacheStorage. IndexedDB oder OPFS
  sind für diesen Modellpfad keine Ersatzablage; LiaScript selbst kann
  unabhängig davon eigene Zustände speichern.

Eine Browserkonsole mit „Tracking Prevention blocked access to storage“ ist
daher ein relevanter Kontextbefund, beweist allein aber noch nicht die Ursache
eines Modellfehlers. Parallel auftretende HTTP-Statuscodes, Redirects, CORS-
Header und der konkrete Storage-Kontext müssen getrennt erfasst werden.

## Schulnetz-Testfälle

Der Runner automatisiert heute Cold, Browserneustart, vollständige externe
Netzsperre und Offline-Clear. Die folgenden Gateway-Manipulationen sind separate
Schulnetz-Abnahmetests; sie sind noch nicht als Proxy-Simulation in den Runner
eingebaut:

| Testfall | Aufbau | Erwartung |
| --- | --- | --- |
| Allowlist-Cold | Nur die oben genannten Hosts und Redirects erlauben | Cold-Inferenz und vollständiger Cache bestehen |
| Harte Offline-Sperre | Nach erfolgreichem Cold-Lauf Browser schließen und alle externen Origins sperren | reguläres Runner-Akzeptanzkriterium mit null Versuchen |
| Range intakt | `Range`/`206`/`Content-Range` unverändert durchreichen | 8-MiB-Segmente werden zusammengesetzt |
| Range konsistent entfernt | Bereits den ersten Range-Request in einen vollständigen `200` umwandeln | Vollabruf funktioniert nur bei ausreichendem Objektlimit |
| Range inkonsistent | Erstes Segment `206`, späteres Segment `200` oder falsche Gesamtlänge | definierter Fehler; Proxykonfiguration muss korrigiert werden |
| Redirectziel gesperrt | `huggingface.co` erlauben, `*.hf.co` oder `*.huggingface.co` sperren | definierter Cold-Fehler zeigt die unvollständige Allowlist |
| CORS-Header entfernt | `Access-Control-Allow-Origin` oder exponiertes `Content-Range` entfernen | Raw-Runtime fällt nur beim ersten Bereich auf Vollabruf zurück; andere CORS-Fehler müssen den Cold-Lauf scheitern lassen |
| Inhaltslimit | Grenzwerte unter und über den oben genannten Objektgrößen testen | Freigabe erst oberhalb der für die gewählte Range-Strategie nötigen Grenze |
| TLS-/URL-Rewrite | Signierte Querystrings oder Antwortbytes verändern | definierter Download- oder Integritätsfehler; Rewrite deaktivieren |
| LMS-Iframe | Kurs im produktiven LMS mit dessen Sandbox-, CSP- und Tracking-Policy laden | dasselbe Neustart-/Offline-Kriterium im eingebetteten Kontext |

Für jeden Schulstandort sollten Report, Browser-/OS-Version, Gateway-Policy,
Zeitpunkt, Cache-Nutzung und eine Netzwerkmitschrift ohne sensible signierte
Querystrings archiviert werden.

## Quality-Modell: eigene Freigabe erforderlich

Die vorhandenen PASS-Reports erzwingen das Kompaktmodell. Ihre WebLLM-Caches
`webllm/model`, `webllm/config` und `webllm/wasm` waren leer. Sie belegen daher
nichts für das Quality-Modell.

Das konfigurierte, optionale Quality-Modell ist `Qwen3-1.7B-q4f16_1-MLC` mit gepinnter
Modellrevision `80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc` und gepinnter
Modellbibliothek `025bcaf3780fa8254f5e5efd3bfea0a5397248f4`. Seine konfigurierte
Downloadschätzung beträgt 984.000.000 B. Zusammen mit 378.614.439 B für das
Kompaktmodell samt ONNX-Laufzeit ergibt das 1.362.614.439 B (ca. 1.299,5 MiB).
Ein freies Origin-Speicherbudget von 2 GiB liegt damit deutlich über der konfigurierten
Gesamtschätzung und lässt rechnerisch etwa 748,5 MiB Abstand. Das belegt jedoch weder ausreichenden
GPU-Speicher noch ein stabiles WebGPU-Gerät. Compact bleibt der sichere Standard; Quality muss
ausdrücklich oder über eine dokumentierte erweiterte Funktion gewählt werden.

### Lokaler WebGPU-Stresstest

Auf dem tatsächlich getesteten lokalen Host liefen Microsoft Edge 151 und eine NVIDIA GeForce
RTX 2070 SUPER (Turing, 8 GB VRAM; gemeldetes maximales WebGPU-Pufferlimit ca. 2 GiB).
Das nun konfigurierte Qwen3-1.7B reproduzierte in vier von vier warmen Minimalläufen dieselbe
Fehlerkette:
`DXGI_ERROR_DEVICE_HUNG` → verlorenes WebGPU-Gerät → `Object has already been disposed`.
Modellcache und Plattenspeicher waren dabei vollständig beziehungsweise ausreichend. Der
`disposed`-Fehler ist somit ein Folgefehler des verlorenen GPU-Geräts und kein Beleg für ein
Quota- oder Downloadproblem.

Die zwischenzeitlich geprüfte Variante Qwen3-0.6B blieb auf demselben Host im beobachteten Cold-
und Warm-Lauf ohne Geräteverlust.
Gemessen wurden ca. 143,4 s Modellinitialisierung und 2,86 s Generierung im Cold-Lauf sowie
ca. 3,13 s Initialisierung und 1,36 s Generierung beim Warmstart. Der Cache wuchs um ungefähr
336,2 MiB; WebLLM meldete rund 1.403,34 MB benötigten VRAM. Diese Werte sind Messungen dieses
einen Systems und keine Mindestanforderungen oder Garantie für andere Rechner. Im semantischen
Stresstest ohne vorgeschaltete deterministische Guards löste 0.6B jedoch nur 6 von 12 Fällen
korrekt. Die Variante wurde deshalb als Bewertungsmodell verworfen und ist kein freigegebener
Grader. Der deterministische Schutzpfad kann einzelne eindeutige Manipulationsversuche
abweisen, ersetzt aber keine ausreichende semantische Modellleistung.

Der reproduzierbare Inhalts-Stresstest wird nach einem aktuellen Build mit
`npm run test:browser-adversarial` ausgeführt. Ein technisch erfolgreicher Lauf beweist nur die
dort geprüften Fälle. Für die aktuelle 1.7B-Konfiguration liegt wegen des reproduzierten
Geräteverlusts auf dem lokalen Testhost noch kein erfolgreicher Browser-Stresstest vor.

Eine Quality-Freigabe braucht pro Browser/OS-Paar weiterhin denselben
Cold→Neustart→Offline-Inferenz→Clear-Ablauf und muss nachweisen, dass wirklich Qwen statt des
Kompakt-Fallbacks inferiert hat. Der lokale Stresstest lief nicht auf den Schulrechnern und ersetzt
weder diesen Ablauf noch Tests im produktiven Schulnetz. Das Quality-Modell darf deshalb für keine
der oben genannten Plattformen pauschal als offline- oder schulnetzgeeignet freigegeben werden.
