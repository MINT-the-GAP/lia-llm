# Quiz-Runtime und Parser-Regression

Der Test verwendet den aktuellen öffentlichen Viewer unter
`https://liascript.github.io/course/` in Playwright Chromium und Firefox.
Nur die importierte `lia-llm/README.md`, ihr `dist/index.js` und die lokale
Test-Fixture werden per Request-Routing bereitgestellt. Der Wochenaufgabenkurs
`5/Deutsch/Lia5_03.md` und seine übrigen Templates werden unverändert geladen.
Es wird nichts veröffentlicht oder am Wochenaufgabenkurs geändert.

## Ausführen

```sh
npm ci
npx playwright-core install chromium firefox
npm run build
npm run test:browser-quiz-runtime
```

Netzzugriff auf den öffentlichen Viewer, GitHub-Rohdateien und die übrigen
Kursimporte ist erforderlich. Der Runner verwendet frische Browserkontexte,
blockiert Service-Worker-Caches und schreibt seinen Bericht einschließlich
Browserversionen, Kurs-Hash und `pageerror`-Ereignissen nach
`test-results/browser-quiz-runtime.json`.

`LIA_LLM_QUIZ_BROWSERS=chromium` beziehungsweise `firefox` begrenzt die Browser.
`LIA_LLM_QUIZ_TIMEOUT_MS` setzt die Ladefrist (Standard: 90000 ms).

## Abdeckung

- `fixtures/quiz-runtime-representative.md`: sechs unmittelbar aufeinanderfolgende
  lange Aufgaben auf einer Folie mit ausführlichen atomaren Kriterien sowie
  einer separaten ganzheitlichen Aufgabe mit zwei vollständigen Referenzvarianten; zusätzlich eine kurze
  Kriterienaufgabe auf einer weiteren Folie. Importiert ausschließlich `lia-llm`.
- Der unveränderte Wochenaufgabenkurs: sechs sichtbare Freitextfelder auf Folie 3
  und Zusammenarbeit mit dem dort aktiven `data-solution-timer="300s"`.
- Auswertung mit `compact` und `quality`, Kriterien/`coverage`, Feedback,
  Sprachprüfung, passende Lösungsvariante, Aktivitätsanzeige, Abbruch,
  erneuter Start sowie Verwerfen verspäteter Resultate beim Folienwechsel.
- Abbruchsignal, Prüfen-Button, Tastaturbedienung und ARIA-Auszeichnungen.
- Eine Größenprüfung verhindert, dass die Ablaufsteuerung erneut in den
  Makrokörper wandert. Die Unit-Tests prüfen zusätzlich die expandierte Form
  mit langen Daten und Sonderzeichen: genau eine Referenzkopie im endgültigen
  Adapter und weniger als 1000 Byte Steuerungsanteil.

Der Runner ersetzt ausschließlich die Modellberechnung durch kontrollierte
Ergebnisse (`passed`, `failed`, `uncertain`, Fehler und ausstehende Promises).
LiaScript-Parser, Makroexpansion, Bundle, UI-Komponenten und Feedbackformatierung
laufen tatsächlich im Browser. Dies prüft die Integration und Zustandsübergänge;
es ist keine neue Messung der semantischen Modellqualität. Die vorhandenen
Scoring-, Evaluator- und Modelltests bleiben dafür zuständig.

## Bekannte Grenzen des aktuellen Viewers und anderer Kursimporte

Die unveränderte zusätzliche Datei `fixtures/quiz-runtime.md` ist eine extreme
Stressprobe mit rund 55 KB, zwölf ausführlichen Kriterien sowie zwei langen
Referenzvarianten pro Aufgabe. Sie lässt sich separat mit
`LIA_LLM_QUIZ_EXTREME=1` ausführen. Sie überschreitet weiterhin eine allgemeine
Parsergrenze des öffentlichen Viewers; der Test meldet dann einen Fehler.
Dieser bekannte Fehlschlag zählt ausdrücklich nicht als bestandener Test.

Die Ursache liegt in
[`Combine.modifyInput`/`currentLocation`](https://github.com/andre-dietrich/parser-combinators/blob/5.1.0/src/Combine.elm):
Eine Makroinjektion ersetzt `stream.input`, während `stream.data` unverändert
bleibt und `stream.position` beim erneuten Parsen weiterwächst. Nach hinreichend
viel expandiertem Text wird daraus eine falsche Spalte. Der
[LiaScript-Quizparser](https://github.com/LiaScript/LiaScript/blob/master/src/elm/Lia/Markdown/Quiz/Vector/Parser.elm)
verwendet diese Spalte als Einrückung, aus der der
[Einrückungsparser](https://github.com/LiaScript/LiaScript/blob/master/src/elm/Lia/Parser/Indentation.elm)
einen regulären Ausdruck mit entsprechend vielen Leerzeichen erstellt.
Auch reine Datenadapter können diese allgemeine Grenze erreichen. Die
Auslagerung entfernt den großen, für jede Aufgabe wiederholten JavaScript-Anteil;
eine beliebige maximale Gesamtlänge kann das Template damit nicht garantieren.

Im Wochenaufgabenkurs hält zusätzlich
[`lia-loot` eine Prüfung bis zu 30 Sekunden intern gesperrt](https://github.com/MINT-the-GAP/lia-loot/blob/main/src/quiz-events.ts).
Ein neutraler Abbruch erhöht weder die Versuchsanzahl noch setzt er eine Lösung;
deshalb endet diese fremde Sperre erst mit ihrem Timeout. `lia-llm` bricht die
Auswertung sofort ab und verwirft verspätete Ergebnisse. Ohne diesen zusätzlichen
Kursimport ist der sofortige Neustart möglich. Der Test verändert weder
Bewertung noch Kursinhalt, um diese Sperre zu umgehen.

## Nachweis vom 20. September 2026

| Browser | Sechs lange Aufgaben | Unveränderter Wochenaufgabenkurs | `pageerror` |
| --- | --- | --- | --- |
| Chromium 151.0.7922.34 | bestanden, 6 Textareas | bestanden, 6 Textareas | 0 |
| Firefox 153.0 | bestanden, 6 Textareas | bestanden, 6 Textareas | 0 |

Der Viewer verwendete `index.5f0767e6.js`. Der SHA-256 des unverändert geladenen
Wochenaufgabenkurses war in beiden Browsern
`552c76d87db480400b161673e16fe66b4b44dc58279051056ea8c7741d4e2753`.
Die repräsentative Fixture umfasst 18.661 UTF-8-Bytes. Der Makrokörper hat
598 statt zuvor 12.257 Bytes; der Referenztext erscheint im endgültigen Adapter
nur einmal. Im Browser wurden außerdem die Textarea-Größe, native ARIA-Zuordnung
und der Übergang des Load-Overlays von Laden zu Bereit geprüft.

Die Negativkontrolle mit der unveränderten README aus `76c1ab5` (0.6.5) scheitert
bei derselben repräsentativen Fixture in Chromium mit `Regular expression too
large` und in Firefox mit `regexp too big`. Die Berichte liegen getrennt unter
`test-results/browser-quiz-runtime.json` und
`test-results/browser-quiz-runtime-baseline.json`.

TypeScript-Prüfung, Build und alle 262 Unit-Tests sind erfolgreich. Die
Reset-Prüfung erfolgt über LiaScripts `send.handle("stop")` in den Unit-Tests;
die Browserprüfung verwendet den tatsächlichen Folienwechsel und das Entfernen
der Quiz-Komponenten. Modellresultate werden wie oben beschrieben kontrolliert
vorgegeben.
