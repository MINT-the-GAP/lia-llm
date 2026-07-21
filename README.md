<!--
author:      MINT-the-GAP, Martin Lommatzsch
version:     0.4.0
language:    de
narrator:    Deutsch Female
comment:     Lokale, kontextsensitive Auswertung offener LiaScript-Antworten anhand einer Musterlösung.
repository:  https://github.com/MINT-the-GAP/lia-llm
script:      ./dist/index.js

attribute:   [WebLLM](https://webllm.mlc.ai/docs/) by MLC is licensed under
             [Apache-2.0](https://github.com/mlc-ai/web-llm/blob/main/LICENSE), and
             [Qwen3-4B](https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC) by the Qwen Team
             is licensed under [Apache-2.0](https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE).
             [Transformers.js](https://huggingface.co/docs/transformers.js/) by Hugging Face is
             licensed under [Apache-2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE),
             and [multilingual mDeBERTa-v3 NLI](https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
             by Moritz Laurer, converted for Transformers.js by Xenova, is licensed under
             [MIT](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blob/main/LICENSE).

@LLMQuiz: @LLMQuiz_(@uid,@0,```@1```)

@LLMQuiz_
<script>
const feedbackId = "lia-llm-feedback-@0"
const solutionId = "lia-llm-solution-@0"
const activityId = "lia-llm-activity-@0"
const runId = activityId + "-" + Date.now().toString(36) + "-" +
  Math.random().toString(36).slice(2)
const evaluationController = new AbortController()
const optionSource = `@'1`
const reference = `@'2`
const answer = `@'input`.replace(/\u2028/gu, "\n")
let active = true
let finished = false
let feedbackEnabled = false
let solutionEnabled = false

window.LiaLLM?.showFeedback?.(feedbackId, "")
window.LiaLLM?.showSolution?.(solutionId, "")
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
  window.LiaLLM?.showSolution?.(solutionId, "")
})

Promise.resolve()
  .then(() => {
    if (!window.LiaLLM) {
      throw new Error("lia-llm konnte nicht geladen werden.")
    }
    if (window.LiaLLM.version !== "0.4.0") {
      throw new Error(`lia-llm 0.4.0 wird benötigt; geladen ist ${window.LiaLLM.version}.`)
    }

    const options = window.LiaLLM.parseMacroOptions(optionSource)
    feedbackEnabled = options.feedback
    solutionEnabled = options.solution

    return window.LiaLLM.evaluate({
      question: "LiaScript-Freitextaufgabe",
      answer,
      reference,
      operator: options.operator ?? undefined,
      criterionThreshold: options.passThreshold
    }, {
      signal: evaluationController.signal,
      onProgress: progress => {
        if (!active) return
        window.LiaLLM?.showActivity?.(activityId, runId, progress.phase)
      }
    })
  })
  .then(result => {
    if (!active) return
    window.LiaLLM?.showSolution?.(
      solutionId,
      solutionEnabled && result.passed ? reference : ""
    )
    const feedback = feedbackEnabled
      ? window.LiaLLM?.feedbackForResult?.(result, "de-DE") ?? null
      : null
    showLearnerFeedback(feedback?.message ?? "")
    finishQuiz(result.passed ? "true" : "false")
  })
  .catch(error => {
    if (!active) return
    window.LiaLLM?.showSolution?.(solutionId, "")
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
<lia-llm-quiz-use hidden></lia-llm-quiz-use>
<lia-llm-activity id="lia-llm-activity-@0" hidden></lia-llm-activity>
<lia-llm-feedback id="lia-llm-feedback-@0"></lia-llm-feedback>
<lia-llm-solution id="lia-llm-solution-@0" hidden></lia-llm-solution>
@end
-->

# lia-llm

    --{{0}}--
`lia-llm` ergänzt ein normales LiaScript-Freitextquiz um eine lokale, semantische
Auswertung anhand einer Musterlösung. Es gibt dafür genau ein öffentliches Makro:
`@LLMQuiz(...)`.

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

Für reproduzierbare Kurse sollte nach Veröffentlichung eines Tags die Version fest angegeben werden:

``` markdown
<!--
import: https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/0.4.0/README.md
-->
```

## Verwendung

Direkt nach dem normalen Textquiz folgt ein als `text` markierter Block. Sein Inhalt ist die
vollständige Musterlösung für den lokalen Vergleich. Sie wird in der gerenderten Aufgabe zunächst
nicht angezeigt. Mit `solution=1` erscheint sie erst, nachdem die Antwort als richtig bewertet wurde.

```` markdown
Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66;solution=1;feedback=1;operator=erklaeren)
Eis besitzt eine geringere Dichte als flüssiges Wasser. Beim Gefrieren bildet das
Wasserstoffbrückennetzwerk eine offene Kristallstruktur, die mehr Volumen einnimmt.
Deshalb schwimmt Eis an der Oberfläche.
```
````

Das Makro benötigt keine Backticks um seine Optionen. Die benannte und die kurze Schreibweise sind
gleichwertig:

``` text
@LLMQuiz(0.66;solution=1;feedback=1)
@LLMQuiz(0.66;1;1)
@LLMQuiz(0.66;solution=1;feedback=1;operator=erklaeren)
@LLMQuiz(0.66;1;1;erklaeren)
```

| Teil | Bedeutung |
| --- | --- |
| `0.66` | Mindestkonfidenz zwischen `0` und `1`; Dezimaltrennzeichen ist der Punkt |
| `solution=1` / zweiter Wert `1` | Musterlösung ausschließlich nach einer richtigen Antwort anzeigen |
| `solution=0` / zweiter Wert `0` | Musterlösung unabhängig vom Ergebnis nie anzeigen |
| `feedback=1` / dritter Wert `1` | kurze priorisierte Rückmeldung einschalten; ein reiner Stilhinweis kann auch bei richtiger Antwort erscheinen |
| `feedback=0` / dritter Wert `0` | zusätzliches Kurzfeedback ausschalten |
| `operator=erklaeren` / vierter Wert `erklaeren` | zusätzlich prüfen, ob die Antwort einen Zusammenhang erklärt |

Ohne Optionen gelten `solution=1` und `feedback=0`:

``` text
@LLMQuiz(0.66)
```

Benannte Optionen dürfen in beliebiger Reihenfolge stehen. Benannte und positionale Angaben werden
innerhalb eines Aufrufs nicht gemischt; Tippfehler und unbekannte Optionen führen zu einer klaren
Fehlermeldung.

`operator` ist optional. Ohne diese Angabe bewertet das Makro fachliche Richtigkeit, Relevanz und
Vollständigkeit allgemein. Mit `operator=erklaeren` erhält das Qualitätsmodell zusätzlich die
Anforderungen an eine Erklärung und kann gezielt melden, dass zwar passende Inhalte vorkommen, der
gefragte Zusammenhang aber noch nicht erklärt wurde. Weitere Operatoren werden auf Grundlage der
fachspezifischen Ausgangstabelle [Operatoren.md](Operatoren.md) und der technischen
[Operator- und Feedbackmatrix](docs/operatoren.md) ergänzt; Operatoren werden dabei nicht mit
einzelnen Sätzen der Musterlösung oder mit Antwortsynonymen gleichgesetzt.

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
vier Pfeiltasten beim Cursor und lösen keinen Folienwechsel aus.

### Kurzes Feedback

Mit `feedback=1` zeigt das Makro höchstens eine kurze, priorisierte Rückmeldung. Je nach Ergebnis
kann das beispielsweise sein:

- „Die Antwort enthält inhaltliche Fehler.“
- „Die Antwort erklärt den gefragten Zusammenhang noch nicht vollständig.“
- „Die Antwort ist deutlich zu kurz, um etwas zu erklären.“
- „Die Antwort entspricht noch nicht den Kriterien einer Erklärung.“
- „Die Antwort ist zu umgangssprachlich verfasst.“

Die fachliche Richtig/Falsch-Entscheidung bleibt von einem bloßen Stilhinweis getrennt: Eine
inhaltlich richtige Antwort wird nicht allein wegen Umgangssprache falsch. Das Makro zeigt keine
Kriterienliste, keine Konfidenzen und keinen Text aus der Musterlösung. Die detaillierten
Diagnosedaten bleiben intern für Tests, Kalibrierung oder ein späteres Fine-Tuning erhalten.

## Modelle, Laden und Cache

Es gibt keine manuelle Schaltfläche „Modell vorbereiten“ und keine getrennten Kompakt-Makros.

Das Kompaktmodell ist schnell, aber bewusst konservativ. Es schlägt keine Wörter in einer festen
Synonymliste nach, sondern schätzt die inhaltliche Folgerung zwischen vollständiger Antwort und
Musterlösung. Eine weiter entfernte, dennoch richtige Paraphrase kann deshalb zunächst unter der
Schwelle liegen. Ein solcher Befund ist jetzt nur noch vorläufig:

1. Sobald LiaScript die erste tatsächlich verwendete `@LLMQuiz`-Instanz rendert und deren
   verborgene Markierung einliest, startet einmalig die gemeinsame Modellvorbereitung. Weitere
   Quizze und spätere Folienbesuche starten keinen zweiten Ladevorgang. Ein nur importiertes, aber
   nirgends gerendertes Makro lädt dagegen keine Modelle.
2. Sind die großen Qwen-Modellgewichte bereits im Browsercache und ist WebGPU verfügbar, wird
   Qwen3-4B zuerst für die Sitzung aktiviert. Auch eine sehr früh abgeschickte erste Antwort wartet
   auf diese gemeinsame Cache-Aktivierung und wird dann direkt mit Qwen geprüft; das Kompaktmodell
   wird dafür nicht zusätzlich geladen.
3. Ist Qwen noch nicht lokal vorhanden, bereitet das Template zunächst das kompakte
   mDeBERTa-v3-NLI-Modell vor und startet Qwen nach den Regeln für Netzverbindung und Zustimmung im
   Hintergrund. Ist Qwen beim Prüfen bereits fertig, wird es sofort verwendet.
4. Trifft eine Antwort noch auf das Kompaktmodell, wird ein positiver Befund sofort übernommen. Ein
   falscher oder unsicherer Befund bleibt vorläufig: Genau dieselbe, zu Beginn erfasste Antwort
   wartet im selben Prüfvorgang auf Qwen und wird nochmals im Gesamtzusammenhang bewertet.
5. Liefert Qwen kein gültiges strukturiertes Ergebnis, ist WebGPU nicht verfügbar oder wurde ein
   nötiger Download abgelehnt, verwendet die Auswertung still den bereits berechneten
   Kompaktbefund.

| Stufe | Modell und Laufzeit | Erster Download | Einordnung |
| --- | --- | ---: | --- |
| Qualität | Qwen3-4B über WebLLM | ca. 2,28 GB | wird bevorzugt, sobald es gecacht oder betriebsbereit ist; besser für Kontext, Synonyme, Paraphrasen und Negationen |
| schneller Start/Fallback | mDeBERTa-v3 NLI über Transformers.js | ca. 355 MB | überbrückt ein noch fehlendes Qualitätsmodell und läuft bei Bedarf mit WASM |

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

Die Hintergrundvorbereitung nach einem bereits positiven Kompaktbefund verzögert dessen Ergebnis
nicht. Muss ein falscher oder unsicherer Kompaktbefund durch Qwen überprüft werden, bleibt dagegen
genau dieser Prüfvorgang bis zum Qualitätsbefund oder zum stillen Rückfall offen.

Vor dem ersten, noch nicht gecachten Download wird bei erkanntem Mobilfunk oder Datensparmodus
gefragt. Weil nicht jeder Browser die Verbindungsart meldet, fragt das große Qualitätsmodell auch
bei unbekannter Verbindung; auf mobilen Geräten gilt dies vorsichtshalber ebenfalls für das
kompakte Modell. Sobald die vollständigen Modellartefakte im Cache liegen, erscheint die
Downloadfrage nicht erneut; lediglich der kleine Arbeitsbalken des aktuell geprüften Quiz bleibt
während Vorbereitung und Auswertung sichtbar.

Modelldateien liegen in der Browser Cache API. Nur beim ersten ungecacheten Download bittet das
Template den Browser zusätzlich um persistenten Website-Speicher; ein Cache-Treffer löst auch diese
Anfrage nicht erneut aus. Die WebLLM-Laufzeit selbst ist im Template gebündelt und wird nicht erst
von einem CDN nachgeladen. Damit können vollständig geladene Modelle im selben Browserprofil und
unter derselben Herkunft auch offline wiederverwendet werden.

Browser dürfen Persistenz ablehnen; ausdrücklich gelöschte Website-Daten, privater Modus,
Speicherbereinigung oder eine andere Herkunft entfernen beziehungsweise trennen den Cache. Eine
absolute, browserübergreifende Dauerhaftigkeit kann eine Webanwendung deshalb nicht garantieren.

## Probieraufgabe

Hier kann die Aufgabe direkt ausprobiert werden. Die Musterlösung bleibt zunächst verborgen und
erscheint nur nach einer als richtig bewerteten Antwort; bei falschen Antworten wird lediglich das
eingeschaltete Kurzfeedback angezeigt:

Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66;solution=1;feedback=1;operator=erklaeren)
Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine geringere
Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.
```

Eine sinngleiche Antwort darf andere Wörter verwenden:

> Wasser hat eine größere Dichte als Eis, da Eis durch die Wasserstoffbrückenbindung sich beim Gefrieren besonders anordnet und somit mehr Volumen pro Molekül braucht. Durch die geringere Dichte von Eis schwimmt es auf dem Wasser.

Eine umgekehrte Kernaussage muss falsch bleiben:

> Eis schwimmt, weil es eine höhere Dichte als flüssiges Wasser besitzt.

Beim Folienwechsel beendet der Makro-`stop`-Handler nur die Ausgabe der verlassenen Aufgabe.
Ein bereits erlaubter Hintergrunddownload und der globale Modellcache bleiben erhalten. Dadurch
erscheint kein verspätetes Quizresultat auf einer anderen Folie, das vorbereitete Modell steht aber
für spätere Aufgaben weiter zur Verfügung.
