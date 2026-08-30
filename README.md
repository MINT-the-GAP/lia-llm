<!--
author:      MINT-the-GAP, Martin Lommatzsch
version:     0.6.0
language:    de
narrator:    Deutsch Female
comment:     Lokale, kontextsensitive Auswertung offener LiaScript-Antworten anhand einer Musterlösung.
repository:  https://github.com/MINT-the-GAP/lia-llm
script:      ./dist/index.js

attribute:   [WebLLM](https://webllm.mlc.ai/docs/) by MLC is licensed under
             [Apache-2.0](https://github.com/mlc-ai/web-llm/blob/main/LICENSE), and
             [Qwen3-1.7B](https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC) and
             [Qwen3-4B](https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC) by the Qwen Team
             are licensed under [Apache-2.0](https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE).
             [Transformers.js](https://huggingface.co/docs/transformers.js/) by Hugging Face is
             licensed under [Apache-2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE),
             and [multilingual mDeBERTa-v3 NLI](https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
             by Moritz Laurer, converted for Transformers.js by Xenova, is licensed under
             [MIT](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blob/main/LICENSE).
             [cspell-trie-lib](https://github.com/streetsidesoftware/cspell/tree/main/packages/cspell-trie-lib)
             and the [German cspell dictionary](https://github.com/streetsidesoftware/cspell-dicts/tree/master/dictionaries/de_DE)
             by Street Side Software are licensed under
             [MIT](https://github.com/streetsidesoftware/cspell/blob/main/LICENSE).

@LLMQuiz: @LLMQuiz_(@uid,@0,```LiaScript-Freitextaufgabe```,```@1```)
@LLMQuiz.question: @LLMQuiz_(@uid,@0,```@1```,```@2```)

@LLMQuiz_
<script output="lia-llm-result-@0">
const feedbackId = "lia-llm-feedback-@0"
const activityId = "lia-llm-activity-@0"
const solutionVariantId = "lia-llm-solution-variant-@0"
const runId = activityId + "-" + Date.now().toString(36) + "-" +
  Math.random().toString(36).slice(2)
const evaluationController = new AbortController()
const optionSource = `@'1`
const question = `@'2`
const referenceSource = `@'3`
const answer = `@'input`.replace(/\u2028/gu, "\n")
let active = true
let finished = false
let feedbackEnabled = false
let referenceVariants = []
let criteriaBlock = null
let quizOptions = null

window.LiaLLM?.showFeedback?.(feedbackId, "")
window.LiaLLM?.showActivity?.(activityId, runId, "selecting-model")
window.LiaLLM?.setSolutionVariant?.(solutionVariantId, runId)

function clearActivity() {
  window.LiaLLM?.showActivity?.(activityId, runId, "")
}

function clearSolutionVariant() {
  window.LiaLLM?.clearSolutionVariant?.(solutionVariantId, runId)
}

function showLearnerFeedback(feedback, languageCheck) {
  if (!active) return
  const visibleFeedback = feedbackEnabled ? feedback : null
  const displayOptions =
    visibleFeedback?.orthographyCorrection || languageCheck
      ? {
          ...(visibleFeedback?.orthographyCorrection
            ? { orthographyCorrection: visibleFeedback.orthographyCorrection }
            : {}),
          ...(languageCheck ? { languageCheck } : {})
        }
      : undefined
  window.LiaLLM?.showFeedback?.(
    feedbackId,
    visibleFeedback?.message ?? "",
    displayOptions
  )
}

function stoppedError() {
  const error = new Error("Die Sprachprüfung wurde beendet.")
  error.name = "AbortError"
  return error
}

function finishQuiz(value) {
  if (!active || finished) return
  finished = true
  clearActivity()
  send.lia(value)
}

function finishUnassessed(message) {
  if (!active || finished) return
  finished = true
  clearActivity()
  clearSolutionVariant()
  window.LiaLLM?.showFeedback?.(feedbackId, "")
  send.lia(message, [], false)
}

function finishTechnicalError(error) {
  const message = error instanceof Error ? error.message : String(error)
  finishUnassessed(message)
}

send.handle("stop", () => {
  active = false
  finished = true
  evaluationController.abort()
  clearActivity()
  clearSolutionVariant()
  window.LiaLLM?.showFeedback?.(feedbackId, "")
})

Promise.resolve()
  .then(() => {
    if (!window.LiaLLM) {
      throw new Error("lia-llm konnte nicht geladen werden.")
    }
    if (window.LiaLLM.version !== "0.6.0") {
      throw new Error(`lia-llm 0.6.0 wird benötigt; geladen ist ${window.LiaLLM.version}.`)
    }

    const options = window.LiaLLM.parseMacroOptions(optionSource)
    quizOptions = options
    criteriaBlock = window.LiaLLM.parseCriteriaBlock(referenceSource) ?? null
    referenceVariants = window.LiaLLM.parseReferenceVariants(
      criteriaBlock?.reference ?? referenceSource
    )
    feedbackEnabled = options.feedback
    if (criteriaBlock && options.operator) {
      throw new Error(
        "Der atomare Aussagenabgleich prüft Inhalte ohne technischen Operator. Entferne operator=...; das Operatorwort darf im Aufgabenwortlaut stehen bleiben."
      )
    }
    if (options.operator && question === "LiaScript-Freitextaufgabe") {
      throw new Error(
        "Operatoren benötigen den echten Aufgabenwortlaut. Verwende @LLMQuiz.question(...)."
      )
    }

    return window.LiaLLM.evaluate({
      question,
      answer,
      reference: referenceVariants[0],
      referenceVariants: referenceVariants.slice(1),
      assessmentEngine: options.assessmentEngine,
      operator: options.operator ?? undefined,
      criteria: criteriaBlock?.criteria,
      criterionThreshold: options.passThreshold
    }, {
      signal: evaluationController.signal,
      maxThinkingTimeMs: options.maxThinkingTimeMs,
      maxThinkingTokens: options.maxThinkingTokens,
      onProgress: progress => {
        if (!active || finished) return
        window.LiaLLM?.showActivity?.(activityId, runId, progress.phase, {
          message: progress.message,
          thinkingTimeLimitMs: progress.thinkingTimeLimitMs,
          thinkingTimeRemainingMs: progress.thinkingTimeRemainingMs
        })
      }
    })
  })
  .then(result => {
    if (!active) return
    if (result.status === "uncertain") {
      const feedback =
        window.LiaLLM?.feedbackForResult?.(result, "de-DE") ?? null
      finishUnassessed(
        feedback?.message ??
          "Die Antwort konnte gerade nicht eindeutig bewertet werden. Versuche die Prüfung erneut."
      )
      return
    }
    if (result.passed) {
      const selectedReferenceIndex =
        Number.isInteger(result.selectedReferenceIndex) &&
        result.selectedReferenceIndex >= 0 &&
        result.selectedReferenceIndex < referenceVariants.length
          ? result.selectedReferenceIndex
          : 0
      window.LiaLLM?.setSolutionVariant?.(
        solutionVariantId,
        runId,
        selectedReferenceIndex
      )
    } else {
      clearSolutionVariant()
    }
    const feedback = feedbackEnabled
      ? window.LiaLLM?.feedbackForResult?.(result, "de-DE") ?? null
      : null
    const languageCheck =
      feedbackEnabled &&
      quizOptions &&
      (quizOptions.rechtschreibung || quizOptions.satzbau)
        ? {
            runId,
            kind:
              quizOptions.rechtschreibung && quizOptions.satzbau
                ? "language"
                : quizOptions.rechtschreibung
                  ? "orthography"
                  : "syntax",
            run: async signal => {
              if (!active) throw stoppedError()
              const languageAnalysis = await window.LiaLLM.evaluateLanguage({
                question,
                answer,
                reference: referenceVariants[0],
                referenceVariants: referenceVariants.slice(1),
                assessmentEngine: "quality",
                operator: quizOptions.operator ?? undefined,
                criteria: criteriaBlock?.criteria,
                criterionThreshold: quizOptions.passThreshold,
                languageAnalysis: {
                  spelling: quizOptions.rechtschreibung,
                  syntax: quizOptions.satzbau
                }
              }, { signal })
              if (!active) throw stoppedError()
              const languageFeedback =
                window.LiaLLM.feedbackForResult(
                  { ...result, languageAnalysis },
                  "de-DE"
                )
              return {
                completed: languageAnalysis?.status === "completed",
                message: languageFeedback?.message ?? "",
                ...(languageFeedback?.orthographyCorrection
                  ? {
                      orthographyCorrection:
                        languageFeedback.orthographyCorrection
                    }
                  : {})
              }
            }
          }
          : undefined
    showLearnerFeedback(feedback, languageCheck)
    finishQuiz(result.status === "passed" ? "true" : "false")
  })
  .catch(error => {
    if (!active) return
    clearSolutionVariant()
    const feedback = window.LiaLLM?.feedbackForError?.(error, "de-DE") ?? null
    if (feedback) {
      finishUnassessed(feedback.message)
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
const solutionVariantId = "lia-llm-solution-variant-@0"
const solutionReferenceSource = `@'3`
const solutionCriteriaBlock =
  window.LiaLLM?.parseCriteriaBlock?.(solutionReferenceSource)
const resultSeparator =
  "\n\n<lia-llm-result-separator></lia-llm-result-separator>"

if (solutionResult === "true" && solutionOptions?.solution) {
  const solutionReferenceVariants =
    window.LiaLLM.parseReferenceVariants(
      solutionCriteriaBlock?.reference ?? solutionReferenceSource
    )
  const storedReferenceIndex =
    window.LiaLLM?.getSolutionVariant?.(solutionVariantId)
  const selectedReferenceIndex =
    Number.isInteger(storedReferenceIndex) &&
    storedReferenceIndex >= 0 &&
    storedReferenceIndex < solutionReferenceVariants.length
      ? storedReferenceIndex
      : 0
  send.liascript(
    solutionReferenceVariants[selectedReferenceIndex] + resultSeparator
  )
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
Ursache-Wirkungs-Beziehungen. Einzelne Sätze werden nicht automatisch zu einzelnen Kriterien;
dafür muss ausdrücklich der unten beschriebene Kriterienmarker verwendet werden.

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

Direkt nach dem normalen Textquiz folgt ein als `text` markierter Block. Im ganzheitlichen Modus
enthält er die vollständige Musterlösung für den lokalen Vergleich. Im Kriterienmodus trennt
`<!-- lia-llm:solution -->` die internen Kernaussagen von einer ausformulierten Musterlösung.
Die Musterlösung wird in der gerenderten Aufgabe zunächst nicht angezeigt. Mit `solution=1`
erscheint sie erst, nachdem die Antwort als richtig bewertet wurde.
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

### Alternative Musterlösungen

Für dieselbe Aufgabe können bis zu acht alternative, jeweils für sich vollständige
Musterlösungen hinterlegt werden. Sie werden innerhalb desselben Lösungsblocks durch die allein
stehende Kommentarzeile `<!-- lia-llm:alternative -->` getrennt:

```` markdown
Aufgabe: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz.question(0.66;solution=1;feedback=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
Eis besitzt eine geringere Dichte als flüssiges Wasser. Deshalb trägt der Auftrieb das Eis
bereits, bevor es vollständig eintaucht.
<!-- lia-llm:alternative -->
Beim Gefrieren entsteht eine offene Kristallstruktur. Dieselbe Masse nimmt dadurch mehr Volumen
ein, ihre Dichte sinkt unter die von flüssigem Wasser und das Eis schwimmt.
```
````

Die Varianten sind vollständige Alternativen mit Oder-Semantik. Die Antwort wird nicht aus
passenden Einzelteilen mehrerer Varianten zusammengesetzt. Nach einer bestandenen Prüfung zeigt
der Musterlösungsblock ausschließlich die inhaltlich passendste, von den Autor:innen hinterlegte
Variante. Bei einem Gleichstand oder falls kein gültiger Auswahlindex vorliegt, wird
deterministisch die erste Variante verwendet. `solution=0` unterdrückt die Anzeige weiterhin
vollständig.

Leere oder inhaltlich doppelte Varianten werden abgewiesen. Mehrere Varianten dürfen zusammen
höchstens 8000 Zeichen enthalten. Die Syntax ist für verschiedene vollständige Lösungswege
gedacht, nicht für Teilkriterien, Teilpunkte oder unterschiedliche Qualitätsstufen eines
Erwartungshorizonts. Alle Varianten bleiben wie die bisherige einzelne Musterlösung im
Kursquelltext und im Browser technisch auffindbar.

### Atomare Kriterien

Soll eine freie Antwort nicht nur als Ganzes, sondern gegen mehrere einzeln erforderliche
Kerninformationen geprüft werden, beginnt jede Aussage mit der allein stehenden Kommentarzeile
`<!-- lia-llm:criterion -->`. Der erste Marker muss zugleich die erste nichtleere Zeile des
Erwartungshorizonts sein. Ohne einen solchen Marker bleibt der bisherige ganzheitliche Vergleich
unverändert aktiv.

```` markdown
Aufgabe: Warum hält Leyla Finn davon ab, die Blechdose aufzubrechen? Erkläre außerdem, was die
unterschiedlichen Reaktionen über ihre Arbeitsweisen zeigen.

<!-- data-solution-button="off" data-llm-textarea="6" -->
[[Antwort]]
```text @LLMQuiz.question(0.55;solution=1;feedback=1,`Warum hält Leyla Finn davon ab, die Blechdose aufzubrechen? Erkläre außerdem, was die unterschiedlichen Reaktionen über ihre Arbeitsweisen zeigen.`)
<!-- lia-llm:criterion -->
Leyla will die Dose nicht beschädigen.
<!-- lia-llm:criterion -->
Leyla untersucht deshalb zunächst den Zettel genau.
<!-- lia-llm:criterion -->
Auf der Rückseite erkennt sie Hinweise, die zu einem passenden Schlüssel führen.
<!-- lia-llm:criterion -->
Leyla arbeitet sorgfältig.
<!-- lia-llm:criterion -->
Leyla arbeitet geduldig.
<!-- lia-llm:criterion -->
Leyla arbeitet aufmerksam.
<!-- lia-llm:criterion -->
Finn ist anfangs ungeduldig.
<!-- lia-llm:criterion -->
Finn möchte möglichst schnell zu einem Ergebnis kommen.
<!-- lia-llm:solution -->
Leyla will die Dose nicht aufbrechen, weil sie sie nicht beschädigen und zunächst den Zettel genau
untersuchen möchte. Auf dessen Rückseite erkennt sie Hinweise, die zu einem passenden Schlüssel
führen. Leyla arbeitet sorgfältig, geduldig und aufmerksam, während Finn anfangs ungeduldig ist
und möglichst schnell zu einem Ergebnis kommen möchte.
```
````

Jeder mit `<!-- lia-llm:criterion -->` beginnende Abschnitt vor dem Lösungsmarker wird als eigenes
Kriterium in der angegebenen Reihenfolge übernommen.
Alle Kriterien sind erforderlich und gleich gewichtet; die Antwort besteht daher nur, wenn jede
Kerninformation erfüllt ist. Ein Kriterium soll genau eine selbstständig prüfbare fachliche Aussage
enthalten. Unabhängige Behauptungen werden getrennt; deshalb bilden im Beispiel „sorgfältig“,
„geduldig“ und „aufmerksam“ drei Kriterien und keine Aufzählung in einem Sammelkriterium.

Der allein stehende Marker `<!-- lia-llm:solution -->` folgt genau einmal auf das letzte Kriterium.
Alles danach ist eine zusammenhängende, frei formulierte Musterlösung und wird nicht als zusätzliches
Kriterium geprüft. Sie soll alle Pflichtaussagen fachlich korrekt wiedergeben, darf diese aber natürlich
verbinden, umstellen und sprachlich ausformulieren.

Der erste Zahlenwert des Makros, im Beispiel `0.55`, bleibt die
Mindestkonfidenz für jedes einzelne Kriterium. Es sind höchstens 16 nichtleere und inhaltlich
verschiedene Kriterien zulässig. Nach einer bestandenen Prüfung zeigt `solution=1` ausschließlich
den ausformulierten Text hinter dem Lösungsmarker; Kriterien und technische Marker bleiben unsichtbar.
`solution=0` unterdrückt die Anzeige. Fehlt der neue Lösungsmarker in einem älteren Kriterienblock,
werden aus Kompatibilitätsgründen weiterhin die zusammengefügten Kriterien als Musterlösung verwendet.

Im Kriterienmodus sucht das Kompaktmodell die stärkste inhaltliche Unterstützung im vollständigen
Antworttext, in Absätzen, in einzelnen Sätzen sowie in benachbarten Zwei- und Drei-Satz-Fenstern.
Dadurch dürfen Lernende die Kernaussagen frei formulieren, anders anordnen und mit einer Einleitung
versehen. Ein starker Widerspruch in einem anderen Ausschnitt bleibt ein Veto und kann nicht durch
einen passenden Einzelsatz überstimmt werden. `0.55` ist der kalibrierte Startwert für atomare
Kriterien mit dem Kompaktmodell. Ein höherer Wert wie `0.66` prüft strenger, erhöht aber besonders
bei Synonymen und umgangssprachlichen Formulierungen die Zahl fälschlich abgelehnter Antworten.

Atomare Kriterien dürfen weder mit vollständigen Musterlösungsalternativen noch mit der technischen
Makrooption `operator=...` kombiniert werden. Das Operatorwort darf weiterhin im sichtbaren
Aufgabenwortlaut stehen, wie das Wort „Erkläre“ im Beispiel. Für die atomare Inhaltsprüfung wird es
jedoch nicht zusätzlich als Operatoroption gesetzt. Ein leerer Abschnitt, Inhalt vor dem ersten
Marker, mehr als 16 Kriterien, ein leerer, mehrfacher oder falsch platzierter Lösungsmarker sowie eine
Mischung mit Alternativen beziehungsweise `operator=...` führt vor dem Modellaufruf zu einer klaren
Fehlermeldung.

### Normalisierter Direktabgleich

Vor jeder Modellauswahl vergleicht `lia-llm` die vollständige Lernendenantwort direkt mit der
vollständigen Musterlösung beziehungsweise mit jeder hinterlegten vollständigen Alternative. Bei
atomaren Kriterien mit Lösungsmarker ist die Vergleichsgrundlage die ausformulierte Musterlösung
hinter `<!-- lia-llm:solution -->`. Ohne Lösungsmarker bleibt sie aus Kompatibilitätsgründen die
Zusammenfügung aller Kriterien. Der Direktabgleich ist nur eine Abkürzung für exakt denselben Text;
jede freie Umformulierung wird weiterhin einzeln gegen alle Kriterien geprüft. Für diesen Vergleich werden
Unicode-Zeichen kompatibilitätsnormalisiert, Groß- und Kleinschreibung angeglichen, aufeinanderfolgende
Leerzeichen und Zeilenumbrüche zu einem Leerzeichen zusammengefasst sowie Leerraum am Anfang und Ende
entfernt.

Sind die normalisierten Texte danach identisch, gilt die Antwort unmittelbar und deterministisch als
richtig; dafür wird kein Modell geladen. Dies ist kein unscharfer Vergleich: Abweichende Satzzeichen,
Wortreihenfolge, Schreibweisen sowie fehlende oder zusätzliche Inhalte werden nicht entfernt.
Synonyme, Umformulierungen und andere inhaltlich gleichwertige Antworten gelangen deshalb weiterhin
in die semantische Modellprüfung.

### Nicht eindeutige Ergebnisse

Ein Modellergebnis mit dem Status `uncertain` wird vom Makro nicht als `false` und damit nicht als
falsche Fachantwort an LiaScript weitergegeben. Stattdessen bleibt die Antwort neutral unbewertet und
es erscheint die Aufforderung, die Prüfung erneut zu versuchen. Nur ein eindeutiges `passed` wird als
richtig und ein eindeutiges `failed` als falsch zurückgemeldet; bei `uncertain` wird auch keine
Musterlösung eingeblendet.

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
| `assessmentengine=compact|quality` | Engine ausschließlich für die Inhaltsprüfung festlegen; ohne Angabe nutzt normaler Inhalt `compact`, die spätere optionale Sprachprüfung unabhängig davon `quality` |
| `operator=...` / vierter Wert | zusätzlich die verlangte Antwortform des gesetzten Operators prüfen |
| `Rechtschreibung=1` | nach der fertigen Inhaltsprüfung einen Button für Rechtschreibung, Zeichensetzung und die sichere Korrekturansicht anbieten |
| `Satzbau=1` | nach der fertigen Inhaltsprüfung eindeutige Grammatikfehler (einschließlich Kasus, Kongruenz und Flexion) sowie Satzbaufehler prüfen; sichere Einwort-Grammatikkorrekturen werden markiert |
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

`assessmentengine` ist ausschließlich als benannte Option zulässig und steuert nur die
Inhaltsprüfung. Eine ausdrückliche Wahl von `assessmentengine=compact` wird dafür niemals
automatisch auf das WebGPU-Qualitätsmodell hochgestuft. Sie kann deshalb nicht mit einem Operator
oder einem positiven Thinking-Limit kombiniert werden; der Parser meldet diesen Konflikt direkt.
Ein allein gesetztes `maxthinkingtime=0s` bleibt mit `compact` zulässig.
`Rechtschreibung=1` und `Satzbau=1` dürfen dagegen mit beiden Inhaltsengines kombiniert werden:
Ihr eigener Quality-Lauf beginnt erst nach dem Inhaltsurteil und ausschließlich durch den
zusätzlichen Button. Ohne Engine-Angabe wählen Operator oder ausdrücklich aktiviertes Thinking für
den Inhalt `quality`; normale Inhaltsprüfungen verwenden `compact`.

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

Bei „Antwort wird gründlich geprüft …“ zeigt die Aktivitätsanzeige zunächst, wie viel zusätzliche
Denkzeit bei Bedarf höchstens vorgesehen ist. Erst wenn der adaptive Thinking-Lauf tatsächlich
beginnt, zählt diese Zeit sekundenweise herunter. Der Zähler ist deshalb keine Zusage für die
gesamte Antwortzeit: Modellauswahl, Laden und der schnelle Erstdurchlauf liegen außerhalb dieses
Thinking-Budgets.

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
ausschließlich verfügbarer Kompaktbefund zu `uncertain` und bittet um eine erneute Prüfung.
Da ohne das erforderliche Modell die Gesamtaufgabe einschließlich ihrer Antwortform nicht
zuverlässig geprüft ist, wird der Versuch weder als richtig noch als fachlich falsch verbucht.

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
eindeutigen Grammatik-/Satzbaufehler. Dazu zählen insbesondere falscher Kasus (zum Beispiel
Akkusativ statt Dativ), Kongruenz, Flexion und Wortstellung. Beide Modi können einzeln oder
gemeinsam verwendet werden:

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

Der erste Prüfen-Klick übergibt ausschließlich die unveränderte Lernendenantwort zur fachlichen
Bewertung. Er enthält keinen Auftrag zur Rechtschreib-, Zeichensetzungs-, Grammatik- oder
Satzbauanalyse.
Das Richtig/Falsch-Ergebnis und gegebenenfalls die Musterlösung werden vollständig ausgegeben,
bevor irgendeine Sprachprüfung gestartet werden kann. Erkennbare Schreibfehler soll der
Quality-Inhaltsjudge bei seiner fachlichen Entscheidung ausdrücklich ignorieren.
Die Optionen `Rechtschreibung` und `Satzbau` verändern weder die gewählte Inhaltsengine noch
deren Zeit- oder Tokenbudget.

Erst danach erscheint bei reinem `Rechtschreibung=1` die Schaltfläche
**Rechtschreibung prüfen**, bei reinem `Satzbau=1` **Grammatik und Satzbau prüfen** und bei
kombinierten Optionen **Sprache prüfen**. Nur dieser zusätzliche Klick startet den lokalen
Sprachmodelllauf. Die angeforderten Fehlerstatistiken entstehen gemeinsam nach diesem Klick. Der
Lauf besitzt ein eigenes Abbruchsignal und kein Inhalts-Thinking-Budget. Das bereits ausgegebene
Inhaltsurteil, seine Qualität und die ausgewählte Musterlösung werden dadurch nicht mehr verändert.
Währenddessen kann weitergearbeitet oder die Folie gewechselt werden; eine neue Inhaltsprüfung
beendet einen noch laufenden optionalen Sprachjob, während ein bereits erlaubter Download und der
Modellcache erhalten bleiben.

Die Grammatikprüfung darf bewusst länger dauern als die bisherige Statistik: Nach der allgemeinen
Sprachanalyse erzeugt der Browser selbst sichere Wortpositionen und Optionen. Stimmen Worttoken,
Satzzeichen und Zwischenräume einer Musterlösung bis auf freigegebene Wortformen bytegenau
überein, kann dieser strenge Referenzanker die Kandidaten lokal eingrenzen; er bestätigt aber
keine Änderung. Ohne einen solchen Anker wählt das Modell ausschließlich zwischen den lokal
erzeugten IDs. Es erhält höchstens 24 Kandidaten je Abschnitt und bis zu 512 Ausgabetokens pro Versuch.
Bei ungültiger Ausgabe ist pro Abschnitt genau ein weiterer Reparaturversuch mit demselben Budget
von 512 Ausgabetokens pro Versuch erlaubt. Der erste Durchgang umfasst höchstens vier Abschnitte
mit insgesamt maximal 96 unterschiedlichen Kandidaten. Für jede `candidate_id` muss das
schemaerzwungene Ergebnis genau eine `option_id` enthalten; `0` bedeutet unverändertes Original.
Enthält der erste Durchgang trotz gemeldeter Grammatikfehler ausschließlich Originaloptionen,
folgt genau ein gezielter zweiter Durchgang über dieselben höchstens vier Abschnitte; auch er darf
sicher ausschließlich Originaloptionen bestätigen. Im theoretischen Grenzfall sind damit
einschließlich der Reparaturversuche höchstens 16 Kandidatenaufrufe möglich. Diese
96-Kandidaten-Grenze gilt für die Discovery ohne strengen Referenzanker. Oberhalb davon bleibt die
gültige Grammatikstatistik sichtbar, die Grammatikvorschau gilt jedoch als fehlgeschlagen; bei
kombinierter Prüfung wird deshalb keine unvollständige Korrekturfassung gezeigt. Ein strenger
Referenzanker überspringt die Discovery und darf unabhängig von der Gesamtzahl lokaler Kandidaten
höchstens acht bytegenau eingegrenzte Stellen einzeln bestätigen. Höchstens acht durch eine
Nicht-Originaloption nominierte
Stellen werden anschließend einzeln in einer auf alle lokal erzeugten Wortformen begrenzten
schemaerzwungenen Entscheidung mit bis zu 96 Tokens pro Versuch geprüft. Erst dieser begrenzte
Bestätigungslauf entscheidet anhand markierter Satzvarianten über die tatsächliche Form; die vorläufige
Discovery-Option ist nicht bindend. Bei einem referenzverankerten Kandidaten wird trotzdem nur die
exakte Referenzform akzeptiert. Auch hier ist genau ein weiterer Reparaturversuch möglich.
Discovery und Bestätigung verwenden keinen freien Denktext, und keiner der Grammatikläufe besitzt
ein kurzes zusätzliches Zeitlimit; der Lauf
bleibt über Folienwechsel oder eine neue Prüfung abbrechbar.

Die Wortzahl wird nach dem Klick im Browser nach einer festen Segmentierungsregel bestimmt und ist
keine Modellschätzung. Für Rechtschreibung wird erst jetzt zusätzlich ein lokal ausgeliefertes
de-DE-Wörterbuch geladen. Es prüft die gesamte Antwort tokenweise und sichert eindeutige Tippfehler
ab; das lokale Quality-Modell ergänzt kontextabhängige Entscheidungen, Groß-/Kleinschreibung und
Zeichensetzung. Mehrdeutige Wörter dürfen nur zwischen geprüften Einzelwort-Kandidaten gewählt
werden. Bei `Satzbau=1` zählt das Quality-Modell zusätzlich eindeutige Grammatik- und
Satzbaufehler. Für die Korrekturansicht erzeugt der Browser ausschließlich einzelne Formen aus
lokal hinterlegten, geschlossenen Gruppen deutscher Artikel, Begleiter und Pronomen sowie von
`sein` und `haben`. Das Modell kann weder Worttexte noch Positionen erzeugen, sondern muss für jede
vorhandene `candidate_id` genau eine lokal vorgegebene `option_id` auswählen. Adjektiv-,
Substantiv- und freie
Verbflexionen können in der Statistik erscheinen, werden aber wegen möglicher Bedeutungsänderungen
nicht automatisch ersetzt. Jede ausgewählte Änderung muss zusätzlich eine begrenzte Modellauswahl
zwischen dem Original und allen lokal freigegebenen Formen bestehen; bei einem bytegenau
referenzverankerten Kandidaten wird dabei ausschließlich die exakte Referenzform akzeptiert. Die
Fehlerzahlen sind Hinweise für die Überarbeitung, keine verbindliche
Korrektur. Schlägt die
gesamte Sprachprüfung einschließlich der Statistik fehl, bleibt das Inhaltsurteil erhalten und der
Button bietet einen neuen Versuch an.

Nach einer erfolgreichen Sprachprüfung wird eine vorhandene vorgeschlagene Fassung automatisch
eingeblendet; danach lässt sie sich mit **Korrigierten Text anzeigen/ausblenden** umschalten.
Darin sind korrigierte Rechtschreib-, Zeichensetzungs- und sichere Einwort-Grammatikstellen türkis,
fett und unterstrichen markiert. Breitere Satzbau- oder Wortstellungsfehler können in der Statistik
erscheinen, werden aber nicht automatisch umgestellt. Die lokale Validierung lässt keine ergänzten,
gelöschten oder umgestellten Wörter, keine Zahlenänderungen und keine veränderten Absätze zu.
Grammatikvorschläge müssen innerhalb genau einer lokal freigegebenen geschlossenen Wortformgruppe
bleiben; eine bloße Ähnlichkeit des Wortstamms reicht ausdrücklich nicht. Da die richtige Form
trotzdem modellgestützt beurteilt wird, bleibt die eingeblendete Fassung ein Vorschlag. Die
ursprünglich eingegebene Antwort wird weder überschrieben noch als LiaScript ausgeführt. Bei einer
fehlerfreien reinen Rechtschreibprüfung kann die unveränderte Fassung zur Kontrolle eingeblendet
werden.

Die Korrekturansicht ist eine zusätzliche, abgesicherte Modellhilfe. Sie wird nicht angezeigt,
wenn mehr als 24 Korrekturstellen oder mehr als acht tatsächliche Grammatikänderungen ausgewählt
werden, die bestätigte Änderungszahl der zuvor ermittelten Fehlerzahl widerspricht, eine Auswahl-ID
ungültig ist oder ein Patch nicht eindeutig auf die Originalantwort passt. Überlappen sich eine
Orthografie- und eine Grammatikänderung, entfällt
die kombinierte Vorschau ebenfalls vollständig. Zum Schutz von Inhalt und Notation
werden Zahlen/Formeln, Codebereiche und Änderungen über mehrere Worttoken hinweg nicht automatisch
korrigiert. Schlägt der vollständige Orthografiepatch fehl, werden Rechtschreib- und
Zeichensetzungszahlen nicht als vermeintlich vollständiges Teilergebnis ausgegeben. Scheitert nur
die zusätzliche Grammatikvorschau, bleibt eine bereits gültige Grammatik-/Satzbaustatistik dagegen
sichtbar; bei einer kombinierten Prüfung wird dann keine unvollständige Korrekturfassung angezeigt.
`Satzbau=1` allein zeigt nur dann eine Korrekturansicht, wenn mindestens eine sichere
Einwort-Grammatikkorrektur bestätigt wurde. Bei null gemeldeten Grammatikfehlern wird kein
separater Grammatik-Patchlauf gestartet.

Für die Fehlerzählung muss das Quality-Modell lokal verfügbar sein; bei Bedarf gelten dafür
dieselben Download-, Cache- und WebGPU-Bedingungen wie für die gründliche Inhaltsprüfung. Ist diese
Prüfung nicht verfügbar oder liefert sie kein gültiges Ergebnis, bleibt die deterministisch
ermittelte Wortzahl sichtbar. Die angeforderten Fehlerzahlen werden dann als nicht verfügbar
gekennzeichnet und nicht fälschlich mit null angegeben. Unsichere freie Modellausgaben werden
durch Wörterbuchtreffer und positionsgebundene Auswahlentscheidungen ergänzt beziehungsweise
verworfen. Scheitert der sichere Gesamtlauf, weist die manuell abgerufene DebugNotiz den Grund als
`language-analysis-output-invalid` aus, ohne Lernenden- oder Modelltext zu protokollieren.

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
3. `assessmentengine=quality` wählt den Quality-Pfad ausdrücklich. Zur Rückwärtskompatibilität
   wählen Operatorprüfung, Sprachanalyse und ein ausdrücklich aktivierter Thinking-Lauf Quality
   auch ohne Engine-Angabe. Das konkrete Qwen-Modell wird vor einem nötigen Download anhand des
   verfügbaren Origin-Speichers gewählt.
4. Ist das gewählte Qwen-Modell noch nicht vollständig lokal vorhanden, wird zunächst ein
   Kompaktbefund berechnet. Der Quality-Download startet erst nach ausdrücklicher Zustimmung;
   innerhalb der dokumentierten Wartefrist kann dieselbe, zu Beginn erfasste Antwort noch mit Qwen
   im Gesamtzusammenhang geprüft werden.
5. Reicht ein bekanntes Speicherbudget nicht einmal für die kleinere Quality-Stufe, startet kein
   Quality-Download. Bei Ablehnung, ungültigem Qwen-Ergebnis, fehlendem WebGPU oder Geräteverlust
   bleibt der vorgesehene Kompakt- beziehungsweise `uncertain`-Fallback erhalten.

| Stufe | Modell und Laufzeit | Erster Download | Einordnung |
| --- | --- | ---: | --- |
| Qualität (bevorzugt, Opt-in) | Qwen3-4B über WebLLM | ca. 2,28 GB (2,12 GiB) | wird bei ausreichendem Origin-Speicher gewählt; benötigt WebGPU und einen Realgerätetest |
| Qualität (kleiner, Opt-in) | Qwen3-1.7B über WebLLM | ca. 984 MB | konservative Auswahl bei kleinerem oder unbekanntem Speicherbudget; benötigt WebGPU |
| sicherer Standard/Fallback | mDeBERTa-v3 NLI über Transformers.js | ca. 379 MB inklusive ONNX-Laufzeit | normale Engine ohne Quality-Opt-in; läuft bei Bedarf mit WASM |

Beim standardmäßigen WASM-Start laufen ONNX-Sitzung und Inferenz des
Kompaktmodells in einem Worker. Dadurch blockiert die automatische Vorbereitung nicht den
LiaScript-UI-Thread. Einbettende Seiten müssen dafür die unter
`test/BROWSER-HARDENING.md` dokumentierte `worker-src`-/Blob-CSP erlauben.

Vor jedem noch nicht vollständig gecachten Quality-Download wertet das Template, soweit verfügbar,
`navigator.storage.estimate()` aus. Bei gültiger `quota` und `usage` gilt als frei
`quota - usage`; zusätzlich bleibt eine Reserve von `max(512 MiB, 10 % der quota)` unangetastet.
Qwen3-4B wird gewählt, wenn 2.280.000.000 B plus Reserve frei sind, andernfalls Qwen3-1.7B, wenn
984.000.000 B plus Reserve frei sind. Reicht ein bekanntes Budget auch dafür nicht, startet kein
Quality-Download. Fehlt die Storage-API, schlägt sie fehl oder liefert sie keine belastbaren Werte,
wird konservativ Qwen3-1.7B gewählt. Ein vollständig gecachtes 4B-Modell kann unabhängig von der
aktuellen Restquote wiederverwendet werden. Ist bereits 1.7B gecacht und passt 4B nur nach dessen
Entfernung, rechnet die Auswahl diesen Platz als freigebbar ein; der Dialog weist auf den Austausch
hin und löscht 1.7B erst nach der ausdrücklichen Bestätigung. Danach wird die Quote erneut geprüft;
meldet der Browser weiterhin zu wenig Platz, beginnt der 4B-Download nicht.

Bei einer tatsächlich für diese Herkunft gemeldeten Quote von 4.000.000.000 B und einem bereits
belegten Kompakt-Cache von etwa 378.614.439 B besteht die 4B-Stufe diese Prüfung einschließlich
Reserve. Erhöht eine Schulrichtlinie dagegen nur den allgemeinen HTTP-Diskcache, ohne die von
`navigator.storage.estimate()` gemeldete Origin-Quote zu erhöhen, bleibt für die Auswahl der
niedrigere Browserwert maßgeblich. Alle Werte sind Schätzungen; ein späteres
`QuotaExceededError` kann der Browser trotzdem melden.

Die Prüfung betrifft ausschließlich den Browsercache der aktuellen Herkunft. Sie misst weder
Arbeitsspeicher noch freien GPU-Speicher und garantiert keine stabile WebGPU-Ausführung. Die
WebLLM-Konfiguration nennt für Qwen3-4B rund 3.431,59 MB benötigten VRAM. Deshalb muss die 4B-Stufe
im tatsächlich eingesetzten Browser auf dem konkreten Schulgerät geprüft werden; ein passender
Cache allein ist keine Freigabe.

Auch eine vermeintlich vollständig gecachte Quality-Stufe darf keine unbemerkte Netzwerkreparatur
starten. Fehlt zwischen Cacheprüfung und Aktivierung ein Artefakt oder ist es beschädigt, bleibt das
Netzwerk gesperrt; der Lauf fällt auf Compact zurück und ein späterer Versuch fordert vor dem
Download erneut eine Bestätigung an.

Auf dem lokal getesteten Edge-151-System mit einer RTX 2070 SUPER verlor Qwen3-1.7B in vier von
vier warmen Minimalläufen das GPU-Gerät (`DXGI_ERROR_DEVICE_HUNG`). Das Modell ist deshalb
bewusst Opt-in und weder für diesen Rechner noch pauschal für die Schulrechner zertifiziert. Die
zwischenzeitlich geprüfte 0.6B-Variante blieb dort technisch stabil, bestand den ohne vorgeschaltete
Schutzregeln durchgeführten semantischen Stresstest aber nur in 6 von 12 Fällen. Sie wird daher
nicht als Bewertungsmodell ausgeliefert.

Seit Version 0.5.14 entfernt das Template vor einem neuen Quality-Download die exakt gepinnten
ausgehenden Qwen3-0.6B-Artefakte. Ein vorhandenes Qwen3-1.7B wird zusätzlich nur dann entfernt,
wenn nach Zustimmung auf Qwen3-4B umgestellt und sein Platz dafür benötigt wird. Ansonsten bleiben
die aktiven Quality-Artefakte und fremde WebLLM-Cacheeinträge erhalten.

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

Das Dialogfeld übernimmt Text- und Hintergrundfarbe gemeinsam aus dem aktuellen LiaScript-Theme.
Dadurch bleiben Fortschritt, Meldungen und Download-Schaltfläche auch im Darkmode kontrastreich.

Ein normaler oder ausdrücklich mit `assessmentengine=compact` gestarteter Aufruf gibt seinen
Kompaktbefund unmittelbar und endgültig aus – auch bei `failed` oder `uncertain`. Er startet weder
einen Qwen-Download noch eine WebGPU-Initialisierung. Nur eine ausdrückliche
Quality-Auswahl beziehungsweise die kompatible implizite Auswahl durch Operator, Sprachanalyse oder
aktiviertes Thinking startet den Quality-Pfad. Dieser wartet bei einem ungecachten oder nur teilweise
gecachten Qualitätsmodell höchstens 30 Sekunden, bei einem vollständig gecachten Warmstart höchstens
180 Sekunden. Danach greift der jeweils vorgesehene Kompakt- beziehungsweise `uncertain`-Fallback;
die dadurch gestartete globale Quality-Vorbereitung läuft jedoch sichtbar bis zum vollständigen
Cache weiter. Weder das Ende der Quiz-Auswertung noch deren `stop`-Signal bricht diesen
Hintergrunddownload ab.

Vor jedem noch nicht vollständig gecachten Quality-Download wird unabhängig von Verbindungsart und
Gerät ausdrücklich gefragt. Das Dialogfeld nennt das ausgewählte Modell, die geschätzte
Downloadgröße und – sofern verfügbar – freien Origin-Speicher sowie Sicherheitsreserve. Erst die
Bestätigung startet den Transfer; eine Ablehnung führt zum vorgesehenen Fallback. Liegen die
vollständigen Artefakte bereits im Cache, erscheint die Downloadfrage nicht erneut. Für das
Kompaktmodell gelten weiterhin die netz- und geräteabhängigen Regeln.

Modelldateien liegen in der Browser Cache API. Nur beim ersten ungecacheten Download bittet das
Template den Browser zusätzlich um persistenten Website-Speicher; ein Cache-Treffer löst auch diese
Anfrage nicht erneut aus. Die WebLLM-Laufzeit selbst ist im Template gebündelt und wird nicht erst
von einem CDN nachgeladen. Damit können vollständig geladene Modelle im selben Browserprofil und
unter derselben Herkunft auch offline wiederverwendet werden.

Seit Version 0.5.8 ist der Quality-Download vollständig von der WebGPU-Initialisierung getrennt:
Konfiguration, Tokenizer, WASM-Laufzeit und alle Gewichts-Shards werden zuerst vollständig gecacht.
Erst danach wird WebGPU initialisiert. Ein späterer GPU-Verlust kann den Netzwerktransfer daher
nicht mehr abbrechen.

Große Modell- und Laufzeitdateien werden in begrenzten Byte-Bereichen geladen. Bleibt ein Bereich
45 Sekunden ohne neue Daten oder endet er vorzeitig, bricht das Template nur diesen Bereich ab und
wiederholt ihn mit kurzen Wartezeiten bis zu viermal. Schlägt anschließend das Schreiben in den
Browsercache fehl, wird die gesamte Shard-Transaktion mit steigenden Pausen bis zu fünfmal versucht;
bis zu drei Shards werden parallel vorbereitet. Bereits vollständig gecachte WebLLM-Shards müssen
dabei nicht erneut übertragen werden. Ein vorübergehender Fehler des Qualitätsmodells sperrt
außerdem keine weiteren Versuche in derselben Sitzung. Ein fataler WebGPU-Laufzeitfehler wie
`device lost`, `DXGI_ERROR_DEVICE_HUNG`, `DXGI_ERROR_DEVICE_REMOVED`,
`DXGI_ERROR_DEVICE_RESET`, ein bereits freigegebenes (`disposed`) Engine-Objekt oder
GPU-Speichermangel schaltet das Qualitätsmodell dagegen für die laufende Sitzung ab. So wird ein
zerstörter GPU-Zustand nicht erneut verwendet; der nun vollständige Modellcache bleibt für einen
späteren Seitenaufruf erhalten und der Kompakt-Fallback bleibt verfügbar.

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
Zugangsdaten. Sie weist außerdem eine fehlgeschlagene Rechtschreib-/Grammatik-/Satzbauausgabe aus, auch wenn
das Quality-Modell selbst weiterhin bereit ist. Für eine Fehlermeldung bitte den vollständigen
Block zwischen `BEGIN LIA-LLM DEBUGNOTIZ` und `END LIA-LLM DEBUGNOTIZ` mitsenden.

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
```text @LLMQuiz.question(0.66;solution=1;feedback=1;assessmentengine=compact;Rechtschreibung=1;Satzbau=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine geringere
Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.
<!-- lia-llm:alternative -->
Flüssiges Wasser hat eine größere Dichte als Eis. Beim Gefrieren ordnen sich Wassermoleküle
durch Wasserstoffbrücken so an, dass mehr Volumen entsteht. Wegen seiner geringeren Dichte
schwimmt Eis auf Wasser.
```


Eine sinngleiche Antwort darf andere Wörter verwenden:

> Wasser hat eine größere Dichte als Eis da Eis durch die Wasserstoffbrückenbindung sich beim Gefrieren besonders anordnet und somit mehr Volumen pro Molekül braucht. Durch die geringere Dichte von Eis schwimmt es auf dem Wasser.

Eine umgekehrte Kernaussage muss falsch bleiben:

> Eis schwimmt, weil es eine höhere Dichte als flüssiges Wasser besitzt.

Beim Folienwechsel beendet der Makro-`stop`-Handler nur die Ausgabe der verlassenen Aufgabe.
Ein bereits erlaubter Hintergrunddownload und der globale Modellcache bleiben erhalten. Dadurch
erscheint kein verspätetes Quizresultat auf einer anderen Folie, das vorbereitete Modell steht aber
für spätere Aufgaben weiter zur Verfügung.
