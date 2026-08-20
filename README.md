<!--
author:      MINT-the-GAP, Martin Lommatzsch
version:     0.5.7
language:    de
narrator:    Deutsch Female
comment:     Lokale, kontextsensitive Auswertung offener LiaScript-Antworten anhand einer Musterlösung.
repository:  https://github.com/MINT-the-GAP/lia-llm
script:      ./dist/index.js?v=0.5.7

attribute:   [WebLLM](https://webllm.mlc.ai/docs/) by MLC is licensed under
             [Apache-2.0](https://github.com/mlc-ai/web-llm/blob/main/LICENSE), and
             [Qwen3-1.7B](https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC) by the Qwen Team
             is licensed under [Apache-2.0](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE).
             [Transformers.js](https://huggingface.co/docs/transformers.js/) by Hugging Face is
             licensed under [Apache-2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE),
             and [multilingual mDeBERTa-v3 NLI](https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
             by Moritz Laurer, converted for Transformers.js by Xenova, is licensed under
             [MIT](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blob/main/LICENSE).

@LLMQuiz: @LLMQuiz_(@uid,@0,```LiaScript-Freitextaufgabe```,```@1```)
@LLMQuiz.question: @LLMQuiz_(@uid,@0,```@1```,```@2```)

@LLMQuiz_
<script output="lia-llm-result-@0">
const feedbackId = "lia-llm-feedback-@0"
const activityId = "lia-llm-activity-@0"
const runId = activityId + "-" + Date.now().toString(36) + "-" +
  Math.random().toString(36).slice(2)
const evaluationController = new AbortController()
const optionSource = `@'1`
const question = `@'2`
const reference = `@'3`
const answer = `@'input`.replace(/\u2028/gu, "\n")
let active = true
let finished = false
let feedbackEnabled = false

window.LiaLLM?.showFeedback?.(feedbackId, "")
window.LiaLLM?.showActivity?.(activityId, runId, "selecting-model")

function clearActivity() {
  window.LiaLLM?.showActivity?.(activityId, runId, "")
}

function showLearnerFeedback(message) {
  if (!active) return
  window.LiaLLM?.showFeedback?.(feedbackId, feedbackEnabled ? message : "")
}

function finishQuiz(value) {
  if (!active || finished) return
  finished = true
  clearActivity()
  send.lia(value)
}

function finishTechnicalError(error) {
  if (!active || finished) return
  finished = true
  clearActivity()
  window.LiaLLM?.showFeedback?.(feedbackId, "")
  const message = error instanceof Error ? error.message : String(error)
  send.lia(message, [], false)
}

send.handle("stop", () => {
  active = false
  finished = true
  evaluationController.abort()
  clearActivity()
  window.LiaLLM?.showFeedback?.(feedbackId, "")
})

Promise.resolve()
  .then(() => {
    if (!window.LiaLLM) {
      throw new Error("lia-llm konnte nicht geladen werden.")
    }
    if (window.LiaLLM.version !== "0.5.7") {
      throw new Error(`lia-llm 0.5.7 wird benötigt; geladen ist ${window.LiaLLM.version}.`)
    }

    const options = window.LiaLLM.parseMacroOptions(optionSource)
    feedbackEnabled = options.feedback
    if (options.operator && question === "LiaScript-Freitextaufgabe") {
      throw new Error(
        "Operatoren benötigen den echten Aufgabenwortlaut. Verwende @LLMQuiz.question(...)."
      )
    }

    return window.LiaLLM.evaluate({
      question,
      answer,
      reference,
      assessmentEngine: options.assessmentEngine,
      operator: options.operator ?? undefined,
      criterionThreshold: options.passThreshold,
      languageAnalysis:
        options.rechtschreibung || options.satzbau
          ? {
              spelling: options.rechtschreibung,
              syntax: options.satzbau
            }
          : undefined
    }, {
      signal: evaluationController.signal,
      maxThinkingTimeMs: options.maxThinkingTimeMs,
      maxThinkingTokens: options.maxThinkingTokens,
      onProgress: progress => {
        if (!active) return
        window.LiaLLM?.showActivity?.(activityId, runId, progress.phase)
      }
    })
  })
  .then(result => {
    if (!active) return
    const feedback = feedbackEnabled
      ? window.LiaLLM?.feedbackForResult?.(result, "de-DE") ?? null
      : null
    showLearnerFeedback(feedback?.message ?? "")
    finishQuiz(result.passed ? "true" : "false")
  })
  .catch(error => {
    if (!active) return
    const feedback = window.LiaLLM?.feedbackForError?.(error, "de-DE") ?? null
    if (feedback) {
      showLearnerFeedback(feedback.message)
      finishQuiz("false")
      return
    }
    finishTechnicalError(error)
  })

"LIA: wait"
</script>
<lia-llm-load-overlay-host></lia-llm-load-overlay-host>
<lia-llm-textarea-host hidden></lia-llm-textarea-host>
<lia-llm-quiz-use hidden></lia-llm-quiz-use>
<lia-llm-activity id="lia-llm-activity-@0" hidden></lia-llm-activity>
<lia-llm-feedback id="lia-llm-feedback-@0"></lia-llm-feedback>
<script style="display:block" modify="false">
const solutionResult = "@input(`lia-llm-result-@0`)"
const solutionOptions = window.LiaLLM?.parseMacroOptions?.(`@'1`)
const solutionReference = `@'3`
const resultSeparator =
  "\n\n<lia-llm-result-separator></lia-llm-result-separator>"

if (solutionResult === "true" && solutionOptions?.solution) {
  send.liascript(solutionReference + resultSeparator)
} else if (solutionResult === "true" || solutionResult === "false") {
  send.liascript(resultSeparator)
} else {
  send.clear()
}
</script>
@end
-->

# lia-llm

    --{{0}}--
`lia-llm` ergänzt ein normales LiaScript-Freitextquiz um eine lokale, semantische
Auswertung anhand einer Musterlösung. Für neue Aufgaben ist
`@LLMQuiz.question(Optionen,Aufgabenwortlaut)` das empfohlene öffentliche Makro.
`@LLMQuiz(...)` bleibt für ältere Aufgaben ohne Operator erhalten.

Die vollständige Antwort wird im Zusammenhang mit der vollständigen Musterlösung betrachtet.
Synonyme, Umschreibungen und andere Satzstrukturen dürfen dieselbe Aussage ausdrücken. Das stärkere
Modell achtet zugleich auf Verneinungen, fachliche Widersprüche und umgekehrte
Ursache-Wirkungs-Beziehungen. Einzelne Sätze werden nicht automatisch zu einzelnen Kriterien.

Die Auswertung ist ein formativer Selbstcheck. Sie ist keine Prüfungsnote und kann eine fachliche
Bewertung durch eine Lehrkraft nicht ersetzen.

## Import

Entwicklungsstand auf `main`:

``` markdown
<!--
import: https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/main/README.md
-->
```

Nach Veröffentlichung dieses Fixes kann die `main`-URL für reproduzierbare Kurse durch die
vollständige Commit-ID des veröffentlichten Stands ersetzt werden. Ein älterer Commit-Pin enthält
weder die Bereichswiederholung noch die lokal ausgelieferte ONNX-Laufzeit.

## Verwendung

Direkt nach dem normalen Textquiz folgt ein als `text` markierter Block. Sein Inhalt ist die
vollständige Musterlösung für den lokalen Vergleich. Sie wird in der gerenderten Aufgabe zunächst
nicht angezeigt. Mit `solution=1` erscheint sie erst, nachdem die Antwort als richtig bewertet wurde.
Bei der Anzeige wird ihr Inhalt vollständig als LiaScript neu geparst. Dadurch werden insbesondere
Markdown-Strukturen sowie Inline- und Blockformeln in TeX gerendert und nicht als Quelltext gezeigt.
Bei `@LLMQuiz.question` wird der echte Aufgabenwortlaut zusätzlich an die Auswertung übergeben.

```` markdown
Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz.question(0.66;solution=1;feedback=1;assessmentengine=quality;operator=erklaeren;maxthinkingtime=15s;maxthinkingtokens=medium,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
Eis besitzt eine geringere Dichte als flüssiges Wasser. Beim Gefrieren bildet das
Wasserstoffbrückennetzwerk eine offene Kristallstruktur, die mehr Volumen einnimmt.
Deshalb schwimmt Eis an der Oberfläche.
```
````

`@LLMQuiz.question(...)` muss in derselben Zeile wie die öffnenden drei Backticks stehen. In der nächsten
Zeile wäre der Aufruf nur Teil der Musterlösung und würde nicht ausgeführt.

Die Optionen benötigen keine Backticks. Der Aufgabenwortlaut wird als zweiter Parameter übergeben;
enthält er wie üblich Kommas, muss er mit Backticks geschützt werden. Benannte und kurze
Optionsschreibweise sind gleichwertig:

``` text
@LLMQuiz.question(0.66;solution=1;feedback=1,`Beschreibe den Verlauf.`)
@LLMQuiz.question(0.66;1;1,`Beschreibe den Verlauf.`)
@LLMQuiz.question(0.66;solution=1;feedback=1;assessmentengine=quality;operator=beschreiben,`Beschreibe den Verlauf.`)
@LLMQuiz.question(0.66;1;1;beschreiben,`Beschreibe den Verlauf.`)
@LLMQuiz.question(0.66;solution=1;feedback=1;assessmentengine=quality;operator=erklaeren;Rechtschreibung=1;Satzbau=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
```

| Teil | Bedeutung |
| --- | --- |
| `0.66` | Mindestkonfidenz zwischen `0` und `1`; Dezimaltrennzeichen ist der Punkt |
| `solution=1` / zweiter Wert `1` | Musterlösung ausschließlich nach einer richtigen Antwort anzeigen |
| `solution=0` / zweiter Wert `0` | Musterlösung unabhängig vom Ergebnis nie anzeigen |
| `feedback=1` / dritter Wert `1` | kurze priorisierte Rückmeldung einschalten; ein reiner Stilhinweis kann auch bei richtiger Antwort erscheinen |
| `feedback=0` / dritter Wert `0` | zusätzliches Kurzfeedback ausschalten |
| `assessmentengine=compact|quality` | Engine explizit festlegen; normale Auswertungen verwenden ohne Angabe `compact`, erweiterte Prüfungen zur Rückwärtskompatibilität implizit `quality` |
| `operator=...` / vierter Wert | zusätzlich die verlangte Antwortform des gesetzten Operators prüfen |
| `Rechtschreibung=1` | Wortzahl sowie getrennte Schätzungen für Zeichensetzungs- und Rechtschreibfehler ausgeben |
| `Satzbau=1` | Wortzahl sowie eine Schätzung für Satzbaufehler ausgeben |
| `maxthinkingtime=...` | maximale zusätzliche Denkzeit: `0s`, `5s`, `10s`, `15s`, `20s` oder `30s`; Standard ist `15s` |
| `maxthinkingtokens=...` | maximales Thinking-Ausgabebudget: `low`, `medium`, `high`, `ultra` oder experimentell `extreme`; Standard ist `medium` |

Ohne Optionen gelten `solution=1` und `feedback=0`:

``` text
@LLMQuiz(0.66)
```

Benannte Optionen dürfen in beliebiger Reihenfolge stehen. Benannte und positionale Angaben werden
innerhalb eines Aufrufs nicht gemischt; Tippfehler und unbekannte Optionen führen zu einer klaren
Fehlermeldung. `Rechtschreibung` und `Satzbau` sind ausschließlich benannte Optionen. Ihre
Namen sind nicht von Groß- und Kleinschreibung abhängig; als Werte sind `0`, `1`, `false`
und `true` zulässig. Sobald mindestens eine dieser Optionen eingeschaltet ist, muss auch
`feedback=1` gesetzt sein, damit die Sprachstatistik sichtbar ausgegeben werden kann.

`assessmentengine` ist ausschließlich als benannte Option zulässig. Eine ausdrückliche Wahl von
`assessmentengine=compact` wird niemals automatisch auf das WebGPU-Qualitätsmodell hochgestuft.
Sie kann deshalb nicht mit einem Operator, aktivierter Rechtschreib-/Satzbauanalyse oder einem
positiven Thinking-Limit kombiniert werden; der Parser meldet diesen Konflikt direkt. Ein allein
gesetztes `maxthinkingtime=0s` bleibt mit `compact` zulässig. Für ältere Makros ohne Engine-Angabe
bleibt die bisherige Auswahl erhalten: Operator, aktivierte Sprachanalyse und ausdrücklich
aktiviertes Thinking wählen implizit `quality`; alle anderen Aufrufe verwenden `compact`.

### Adaptiver Denkmodus

Das Qualitätsmodell bewertet zunächst kurz und strukturiert. Ist das Ergebnis grenznah oder
`uncertain`, umfasst die Antwort mindestens 160 Wörter oder ist eine Operatorantwort ab 24 Wörtern
zu prüfen, darf für das betroffene Kriterium höchstens ein zusätzlicher Thinking-Lauf folgen.
Für einen solchen Zweitlauf gelten grundsätzlich `maxthinkingtime=15s` und
`maxthinkingtokens=medium`. Ab 160 Wörtern wird jede nicht ausdrücklich gesetzte Dimension adaptiv
auf `maxthinkingtime=30s` beziehungsweise `maxthinkingtokens=ultra` angehoben. Eine explizit
gesetzte Zeit oder Tokenstufe bleibt jeweils erhalten; nur die jeweils fehlende Angabe wird
automatisch ergänzt.

Die Zeitangabe begrenzt nur den zusätzlichen Thinking-Lauf nach dem schnellen Erstdurchlauf; Laden
und Initialisieren des Modells zählen nicht dazu. Sie ist unter WebGPU eine weiche Obergrenze, weil
ein bereits laufender GPU-Schritt erst anschließend unterbrochen werden kann. `0s` deaktiviert den
Thinking-Lauf. Die Tokenpresets entsprechen `low=256`, `medium=512`, `high=768`,
`ultra=1024` und `extreme=2048`. Dieses Gesamt-Completion-Budget umfasst sowohl den internen
`<think>`-Block als auch das abschließende JSON und gilt als gemeinsames Budget für die gesamte
Antwort, nicht erneut pro Kriterium. `ultra` ist nur für leistungsfähige Geräte gedacht;
`extreme` ist eine experimentelle Desktop-Option und keine Empfehlung für Schulgeräte.

Die vorkompilierte WebLLM-Konfiguration von Qwen besitzt ein Kontextfenster von insgesamt 4096
Tokens. Darin müssen bereits der tokenisierte Prompt und das Chat-Template sowie anschließend
Thinking und Ergebnis-JSON Platz finden. `extreme=2048` ist daher nur eine Obergrenze: Bei einem
langen Prompt steht entsprechend weniger Ausgabeplatz zur Verfügung. Werte über 2048 werden von
diesem Template nicht unterstützt.

Bei Zeitablauf, erreichtem Tokenlimit, unvollständigem Denkblock oder ungültigem JSON bleibt das
gültige schnelle Erstergebnis erhalten. Der Denktext wird ausschließlich lokal verarbeitet und
nicht angezeigt. Werden Thinking-Optionen mit positiver Denkzeit ausdrücklich gesetzt, wartet die
Auswertung auf das Qualitätsmodell; `0s` deaktiviert dies. Ohne ausdrückliche Angabe bleibt der
schnelle Kompakt-Fallback unverändert.

`operator` ist optional. Ohne diese Angabe bewertet das Makro fachliche Richtigkeit, Relevanz und
Vollständigkeit allgemein. Aktiv sind `erklaeren`, `erlaeutern`, `beschreiben`,
`begruenden`, `vergleichen` und `beurteilen`; Umlaute und dokumentierte
Imperativformen werden normalisiert. Das Qualitätsmodell erhält für jedes Profil einen strukturierten
Antwortvertrag mit erforderlichen Teilleistungen, Beleg- und Verfahrensregeln sowie Grenzen.
Es meldet bei einer fehlenden Teilleistung eine validierte Kriteriums-ID; dadurch kann das
priorisierte, konkrete Operatorfeedback angezeigt werden.
Ein Operator kann nur mit `@LLMQuiz.question` verwendet werden, weil sein konkreter Umfang aus dem
echten Aufgabenwortlaut folgt. Der Operator wird nicht heimlich aus einem Verb erkannt und nicht
pauschal einem Anforderungsbereich zugeordnet. Die fachliche Grundlage steht in
[Operatoren.md](Operatoren.md), die technische Matrix in [docs/operatoren.md](docs/operatoren.md).

Operatoraufgaben bestehen erst nach der Prüfung durch das Qualitätsmodell. Das Kompaktmodell darf
den Fachinhalt vorprüfen, aber die verlangte Antwortform nicht allein freigeben. Ist die
Qualitätsprüfung etwa ohne WebGPU oder nach einem Modellfehler nicht verfügbar, wird ein sonst
bestandener Kompaktbefund zu `uncertain` und bittet bei `feedback=1` um eine
erneute Prüfung; er wird nicht fälschlich freigegeben. Ein bereits erkannter fachlicher Fehler oder
unvollständiger Inhalt bleibt dagegen der vorrangige Befund.

Das ältere `@LLMQuiz(Optionen)` verwendet weiterhin den allgemeinen Kontext
„LiaScript-Freitextaufgabe“ und ist deshalb nur ohne Operator zulässig.

Der native LiaScript-Lösungsbutton bleibt bei dieser Quizform ausgeschaltet; die sichtbare Ausgabe
wird ausschließlich über `solution` gesteuert. Soll die Musterlösung nie erscheinen:

```` markdown
<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66;solution=0;feedback=1)
Hier steht weiterhin die vollständige Musterlösung für den lokalen Vergleich.
```
````

`solution=0` ist kein Zugriffsschutz: Die lokale Auswertung benötigt die Musterlösung, deshalb
bleibt sie im Kursquelltext und im Browser auffindbar.

### Mehrzeilige Antworten

`data-llm-textarea="5"` erzeugt ein vergrößerbares Feld mit fünf sichtbaren Zeilen. Werte von 2 bis
12 sind möglich. Absätze und Leerzeilen bleiben bei der Auswertung erhalten. Im Feld bleiben alle
vier Pfeiltasten beim Cursor und lösen keinen Folienwechsel aus. Das sichtbare Feld liegt in einem
eigenen Shadow-DOM-Sidecar; die von LiaScript verwaltete Quiz-Kindliste bleibt dabei unverändert.

### Kurzes Feedback

Mit `feedback=1` zeigt das Makro höchstens eine kurze, priorisierte Rückmeldung. Je nach Ergebnis
kann das beispielsweise sein:

- „Die Antwort enthält inhaltliche Fehler.“
- „Die Antwort bearbeitet die gefragten Inhalte noch nicht vollständig.“
- „Die Antwort ist deutlich zu kurz, um etwas zu erklären.“
- „Stelle Ursache, Prinzip oder Bedingung und die daraus folgende Wirkung nachvollziehbar in Beziehung.“
- „Die verlangte Antwortform konnte gerade nicht zuverlässig geprüft werden.“
- „Die Antwort ist zu umgangssprachlich verfasst.“

Die fachliche Richtig/Falsch-Entscheidung bleibt von einem bloßen Stilhinweis getrennt: Eine
inhaltlich richtige Antwort wird nicht allein wegen Umgangssprache falsch. Das Makro zeigt keine
Kriterienliste, keine Konfidenzen und keinen Text aus der Musterlösung. Das detaillierte
`EvaluationResult` wird nur an den aufrufenden Code zurückgegeben. DebugNotizen enthalten keine
Lernendenantworten oder Modellantworten; es findet keine Speicherung für späteres Fine-Tuning statt.

### Optionale Sprachstatistik

Mit `Rechtschreibung=1` ergänzt das Kurzfeedback die Gesamtzahl der Wörter sowie getrennte
Zählungen für Zeichensetzungs- und Rechtschreibfehler. `Satzbau=1` ergänzt die Zahl der
Satzbaufehler. Beide Modi können einzeln oder gemeinsam verwendet werden:

```` markdown
Aufgabe: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz.question(0.66;solution=1;feedback=1;operator=erklaeren;Rechtschreibung=1;Satzbau=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
Eis besitzt eine geringere Dichte als flüssiges Wasser. Beim Gefrieren entsteht eine
offene Kristallstruktur, die mehr Volumen einnimmt.
```
````

Der echte Aufgabenwortlaut steht bei `@LLMQuiz.question` nach dem Komma als zweiter
Makroparameter. Enthält er ein Komma, schützen die Backticks den vollständigen Text vor der
Parametertrennung.

Die Wortzahl wird im Browser nach einer festen Segmentierungsregel bestimmt und ist deshalb keine
Modellschätzung. Die Fehlerzahlen stammen dagegen aus einer konservativen Prüfung durch das lokal
ausgeführte Quality-Modell. Sie sind Hinweise für die Überarbeitung, keine verbindliche Korrektur:
Weder Rechtschreibung, Zeichensetzung noch Satzbau verändern für sich die fachliche
Richtig/Falsch-Entscheidung.

Für die Fehlerzählung muss das Quality-Modell lokal verfügbar sein; bei Bedarf gelten dafür
dieselben Download-, Cache- und WebGPU-Bedingungen wie für die gründliche Inhaltsprüfung. Ist diese
Prüfung nicht verfügbar oder liefert sie kein gültiges Ergebnis, bleibt die deterministisch
ermittelte Wortzahl sichtbar. Die angeforderten Fehlerzahlen werden dann als nicht verfügbar
gekennzeichnet und nicht fälschlich mit null angegeben.

## Modelle, Laden und Cache

Es gibt keine manuelle Schaltfläche „Modell vorbereiten“ und keine getrennten Kompakt-Makros.

Das Kompaktmodell ist der sichere Standard und bewusst konservativ. Es schlägt keine Wörter in
einer festen Synonymliste nach, sondern schätzt die inhaltliche Folgerung zwischen vollständiger
Antwort und Musterlösung. Eine weiter entfernte, dennoch richtige Paraphrase kann deshalb zunächst unter der
Schwelle liegen. Das stärkere Quality-Modell ist eine optionale Erweiterung:

1. Sobald LiaScript die erste tatsächlich verwendete `@LLMQuiz`-Instanz rendert und deren
   verborgene Markierung einliest, startet einmalig die Vorbereitung des Kompaktmodells. Weitere
   Quizze und spätere Folienbesuche starten keinen zweiten Ladevorgang. Ein nur importiertes, aber
   nirgends gerendertes Makro lädt dagegen keine Modelle.
2. Normale Aufrufe ohne Engine-Angabe und ohne erweiterte Quality-Funktion werden ausschließlich
   mit Compact geprüft. Sie laden Qwen nicht und benötigen kein WebGPU.
3. `assessmentengine=quality` wählt Qwen3-1.7B ausdrücklich. Zur Rückwärtskompatibilität wählen
   Operatorprüfung, Sprachanalyse und ein ausdrücklich aktivierter Thinking-Lauf Quality auch ohne
   Engine-Angabe.
4. Ist Qwen noch nicht lokal vorhanden, wird zunächst ein Kompaktbefund berechnet. Nach den Regeln
   für Netzverbindung und Zustimmung startet anschließend die Quality-Vorbereitung; innerhalb der
   dokumentierten Wartefrist kann dieselbe, zu Beginn erfasste Antwort noch mit Qwen im
   Gesamtzusammenhang geprüft werden.
5. Liefert Qwen kein gültiges strukturiertes Ergebnis, ist WebGPU nicht verfügbar, geht das
   GPU-Gerät verloren oder wurde ein nötiger Download abgelehnt, bleibt der vorgesehene
   Kompakt- beziehungsweise `uncertain`-Fallback erhalten.

| Stufe | Modell und Laufzeit | Erster Download | Einordnung |
| --- | --- | ---: | --- |
| Qualität (Opt-in) | Qwen3-1.7B über WebLLM | ca. 984 MB | stärkere generative Gesamtprüfung; benötigt WebGPU und ist ohne gerätespezifischen Test nicht für Schulrechner freigegeben |
| sicherer Standard/Fallback | mDeBERTa-v3 NLI über Transformers.js | ca. 379 MB inklusive ONNX-Laufzeit | normale Engine ohne Quality-Opt-in; läuft bei Bedarf mit WASM |

Beim standardmäßigen WASM-Start laufen ONNX-Sitzung und Inferenz des
Kompaktmodells in einem Worker. Dadurch blockiert die automatische Vorbereitung nicht den
LiaScript-UI-Thread. Einbettende Seiten müssen dafür die unter
`test/BROWSER-HARDENING.md` dokumentierte `worker-src`-/Blob-CSP erlauben.

Die konfigurierte Downloadschätzung beträgt 984.000.000 B für das Qualitätsmodell und
378.614.439 B für Kompaktmodell samt ONNX-Laufzeit, zusammen also 1.362.614.439 B
(ca. 1.362,6 MB beziehungsweise 1.299,5 MiB). Die im Schulrechner-Log gemeldeten 2.048 MiB
freier Origin-Speicher liegen über dieser Schätzung. Die tatsächliche Origin-Nutzung kann durch
Browser-Metadaten und weitere Website-Daten abweichen. Ausreichender Browser-Speicher sagt zudem
nichts über den getrennten GPU-Speicher und die Stabilität des WebGPU-Geräts aus.

Auf dem lokal getesteten Edge-151-System mit einer RTX 2070 SUPER verlor Qwen3-1.7B in vier von
vier warmen Minimalläufen das GPU-Gerät (`DXGI_ERROR_DEVICE_HUNG`). Das Modell ist deshalb
bewusst Opt-in und weder für diesen Rechner noch pauschal für die Schulrechner zertifiziert. Die
zwischenzeitlich geprüfte 0.6B-Variante blieb dort technisch stabil, bestand den ohne vorgeschaltete
Schutzregeln durchgeführten semantischen Stresstest aber nur in 6 von 12 Fällen. Sie wird daher
nicht als Bewertungsmodell ausgeliefert.

Beim Wechsel auf Version 0.5.7 entfernt das Template vor einem neuen Quality-Download
ausschließlich die exakt gepinnten ausgehenden Qwen3-0.6B- und alten Qwen3-4B-Artefakte. Das
aktuelle Qwen3-1.7B sowie fremde WebLLM-Cacheeinträge bleiben erhalten.

Es gibt zwei bewusst getrennte Anzeigen:

- Direkt am Quiz erscheint während jedes Prüfvorgangs ein schmaler Arbeitsbalken. Sein Text zeigt,
  ob gerade das Kompaktmodell vorbereitet, die Antwort schnell geprüft, die Qualitätsprüfung
  vorbereitet oder die Antwort gründlich geprüft wird. Die eigentliche Inferenz liefert keine
  verlässliche Prozentzahl; deshalb läuft dieser Balken ohne erfundenen Prozentwert.
- Der große Fortschrittsbalken erscheint ausschließlich bei einem echten Netzwerkdownload und
  zeigt dessen messbaren Fortschritt. Sind alle Artefakte bereits im Browsercache, werden sie ohne
  diesen globalen Balken für die Sitzung in Arbeitsspeicher und WebGPU aktiviert. Eine gerade
  wartende Aufgabe zeigt dabei weiterhin ihren kleinen lokalen Arbeitsbalken. Dasselbe Dialogfeld
  bleibt für eine nötige Download-Zustimmung oder einen Ladefehler sichtbar.

Ein normaler oder ausdrücklich mit `assessmentengine=compact` gestarteter Aufruf gibt seinen
Kompaktbefund unmittelbar und endgültig aus – auch bei `failed` oder `uncertain`. Er startet weder
einen Qwen-Download noch eine WebGPU-Initialisierung. Nur eine ausdrückliche
Quality-Auswahl beziehungsweise die kompatible implizite Auswahl durch Operator, Sprachanalyse oder
aktiviertes Thinking startet den Quality-Pfad. Dieser wartet bei einem ungecachten oder nur teilweise
gecachten Qualitätsmodell höchstens 30 Sekunden, bei einem vollständig gecachten Warmstart höchstens
180 Sekunden. Danach greift der jeweils vorgesehene Kompakt- beziehungsweise `uncertain`-Fallback;
eine bereits durch diesen Quality-Aufruf gestartete Hintergrundvorbereitung darf für spätere
Quality-Antworten weiterlaufen.

Vor dem ersten, noch nicht gecachten Download wird bei erkanntem Mobilfunk oder Datensparmodus
gefragt. Weil nicht jeder Browser die Verbindungsart meldet, fragt das Template beim Download des
Qualitätsmodells auch
bei unbekannter Verbindung; auf mobilen Geräten gilt dies vorsichtshalber ebenfalls für das
kompakte Modell. Sobald die vollständigen Modellartefakte im Cache liegen, erscheint die
Downloadfrage nicht erneut; lediglich der kleine Arbeitsbalken des aktuell geprüften Quiz bleibt
während Vorbereitung und Auswertung sichtbar.

Modelldateien liegen in der Browser Cache API. Nur beim ersten ungecacheten Download bittet das
Template den Browser zusätzlich um persistenten Website-Speicher; ein Cache-Treffer löst auch diese
Anfrage nicht erneut aus. Die WebLLM-Laufzeit selbst ist im Template gebündelt und wird nicht erst
von einem CDN nachgeladen. Damit können vollständig geladene Modelle im selben Browserprofil und
unter derselben Herkunft auch offline wiederverwendet werden.

Große Modell- und Laufzeitdateien werden in begrenzten Byte-Bereichen geladen. Bleibt ein Bereich
45 Sekunden ohne neue Daten oder endet er vorzeitig, bricht das Template nur diesen Bereich ab und
wiederholt ihn mit kurzen Wartezeiten bis zu viermal. Bereits vollständige Bereiche beziehungsweise
WebLLM-Shards müssen dabei nicht erneut übertragen werden. Ein vorübergehender Fehler des
Qualitätsmodells sperrt außerdem keine weiteren Versuche in derselben Sitzung. Ein fataler
WebGPU-Laufzeitfehler wie `device lost`, `DXGI_ERROR_DEVICE_HUNG`,
`DXGI_ERROR_DEVICE_REMOVED`, `DXGI_ERROR_DEVICE_RESET`, ein bereits freigegebenes
(`disposed`) Engine-Objekt oder GPU-Speichermangel schaltet das Qualitätsmodell dagegen für die
laufende Sitzung ab. So wird ein zerstörter GPU-Zustand nicht erneut verwendet; der
Kompakt-Fallback bleibt verfügbar.

Die exakt zum Bundle passende ONNX-Web-Laufzeit (`.mjs` und `.wasm`) liegt neben
`dist/index.js`. Dadurch muss Edge sie nicht mehr von einem zusätzlichen CDN in den anfälligen
WASM-Cache kopieren. Die eigentlichen Modellgewichte kommen weiterhin von Hugging Face; das
WebLLM-Model-Library-WASM des Qualitätsmodells kommt aus dessen konfigurierter GitHub-Quelle.
Schulfilter müssen diese Quellen zulassen. Nach ausgeschöpften Wiederholungen wechselt die
Ladeanzeige in einen Fehlerzustand mit erneuter Versuchsmöglichkeit, statt unbegrenzt im
Ladezustand zu bleiben.

Browser dürfen Persistenz ablehnen; ausdrücklich gelöschte Website-Daten, privater Modus,
Speicherbereinigung oder eine andere Herkunft entfernen beziehungsweise trennen den Cache. Eine
absolute, browserübergreifende Dauerhaftigkeit kann eine Webanwendung deshalb nicht garantieren.

### DebugNotiz für Lade-, Cache- und WebGPU-Fehler

Bei einem endgültigen Ladefehler schreibt lia-llm automatisch genau eine aufklappbare
`[Lia-LLM DebugNotiz]` in die Entwicklerkonsole. Nach einem erfolgreichen Netzwerkdownload wird
außerdem kontrolliert, ob Modell und Laufzeit wirklich im Browsercache angekommen sind; ein
fehlgeschlagener Cache-Schreibvorgang erhält ebenfalls eine DebugNotiz. Der Bericht unterscheidet
unter anderem Offlinebetrieb, HTTP- und Proxyfehler, blockierte Cross-Origin-Anfragen,
Range-/Größenprobleme, beschädigte Artefakte, fehlenden oder gesperrten CacheStorage und zu wenig
Speicherplatz. WebGPU-Geräteverlust, die genannten DXGI-Fehler, GPU-Speichermangel und Meldungen
über bereits freigegebene Objekte werden als Laufzeitfehler ausgewiesen. `Object has already been
disposed` ist dabei typischerweise der Folgefehler eines zuvor verlorenen GPU-Geräts und kein
Hinweis auf zu wenig freien Browser-Speicherplatz. Wo der Browser mehrere Ursachen nicht
unterscheiden kann, wird die Einordnung
ausdrücklich als Vermutung gekennzeichnet.

Der aktuelle Zustand kann jederzeit manuell geprüft werden:

``` javascript
await LiaLLM.debugReport()
```

Der Aufruf protokolliert die lesbare Analyse und liefert gleichzeitig ein reines JSON-Objekt
zurück. In Edge oder Chrome lässt es sich beispielsweise direkt als Text kopieren:

``` javascript
copy(JSON.stringify(await LiaLLM.debugReport({ print: false }), null, 2))
```

Die DebugNotiz enthält Browser-, Netzwerk-, Speicher-, Cache- und Artefaktmetadaten, aber keine
Aufgabenstellung, Musterlösung, Schülerantwort, Response-Bodies, URL-Queryparameter oder
Zugangsdaten. Für eine Fehlermeldung bitte den vollständigen Block zwischen
`BEGIN LIA-LLM DEBUGNOTIZ` und `END LIA-LLM DEBUGNOTIZ` mitsenden.

Der reproduzierbare Cold-/Neustart-/Offline-Härtetest samt Schulnetzbedingungen ist in
[`test/BROWSER-HARDENING.md`](test/BROWSER-HARDENING.md) dokumentiert.

## Probieraufgabe

Hier kann die Aufgabe direkt ausprobiert werden. Die Musterlösung bleibt zunächst verborgen und
erscheint nur nach einer als richtig bewerteten Antwort; bei falschen Antworten wird lediglich das
eingeschaltete Kurzfeedback angezeigt:

Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.


<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
[[?]] Hinweis
```text @LLMQuiz(0.66;solution=1;feedback=1;Rechtschreibung=1;Satzbau=1)
Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine geringere
Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.
```


Eine sinngleiche Antwort darf andere Wörter verwenden:

> Wasser hat eine größere Dichte als Eis da Eis durch die Wasserstoffbrückenbindung sich beim Gefrieren besonders anordnet und somit mehr Volumen pro Molekül braucht. Durch die geringere Dichte von Eis schwimmt es auf dem Wasser.

Eine umgekehrte Kernaussage muss falsch bleiben:

> Eis schwimmt, weil es eine höhere Dichte als flüssiges Wasser besitzt.

Beim Folienwechsel beendet der Makro-`stop`-Handler nur die Ausgabe der verlassenen Aufgabe.
Ein bereits erlaubter Hintergrunddownload und der globale Modellcache bleiben erhalten. Dadurch
erscheint kein verspätetes Quizresultat auf einer anderen Folie, das vorbereitete Modell steht aber
für spätere Aufgaben weiter zur Verfügung.
