<!--
author:      MINT-the-GAP, Martin Lommatzsch
version:     0.6.5
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

@LLMQuiz: @LLMQuiz_(@uid,@0,```@1```,```@2```)
@LLMQuiz.question: @LLMQuiz_(@uid,@0,```@1```,```@2```)

@LLMQuiz_
<script output="lia-llm-result-@0">
const feedbackId = "lia-llm-feedback-@0"
const activityId = "lia-llm-activity-@0"
const solutionVariantId = "lia-llm-solution-variant-@0"
const runId = activityId + "-" + Date.now().toString(36) + "-" +
  Math.random().toString(36).slice(2)
const evaluationController = new AbortController()
const rememberedCheckActivation = window.__liaLlmLastQuizCheckActivation
if (rememberedCheckActivation) {
  delete window.__liaLlmLastQuizCheckActivation
}
let activeCheckButton =
  typeof document !== "undefined" &&
  typeof HTMLButtonElement !== "undefined" &&
  document.activeElement instanceof HTMLButtonElement &&
  document.activeElement.classList.contains("lia-quiz__check")
    ? document.activeElement
    : typeof HTMLButtonElement !== "undefined" &&
        rememberedCheckActivation?.button instanceof HTMLButtonElement &&
        rememberedCheckActivation.button.isConnected &&
        Date.now() - rememberedCheckActivation.observedAt < 2000
      ? rememberedCheckActivation.button
      : null
let checkButtonInitialDisabled = false
let checkButtonInitialAriaBusy = null
const activeQuizRuns =
  window.__liaLlmActiveQuizRuns instanceof Map
    ? window.__liaLlmActiveQuizRuns
    : new Map()
window.__liaLlmActiveQuizRuns = activeQuizRuns
const optionSource = `@'1`
const question = `@'2`
const referenceSource = `@'3`
const answer = `@'input`.replace(/\u2028/gu, "\n")
let active = true
let finished = false
let feedbackEnabled = false
let referenceVariants = []
let criteriaBlock = null
let evaluationCriteria
let evaluationThresholds = null
let quizOptions = null

function clearActivity() {
  try {
    window.LiaLLM?.showActivity?.(activityId, runId, "")
  } catch {}
}

function clearSolutionVariant() {
  try {
    window.LiaLLM?.clearSolutionVariant?.(solutionVariantId, runId)
  } catch {}
}

function setCheckButtonBusy(busy) {
  if (!activeCheckButton?.isConnected) return
  activeCheckButton.disabled = busy || checkButtonInitialDisabled
  if (busy) {
    activeCheckButton.setAttribute("aria-busy", "true")
  } else if (checkButtonInitialAriaBusy === null) {
    activeCheckButton.removeAttribute("aria-busy")
  } else {
    activeCheckButton.setAttribute("aria-busy", checkButtonInitialAriaBusy)
  }
}

function releaseQuizRun() {
  if (activeQuizRuns.get(activityId) !== supersedeEvaluation) return
  activeQuizRuns.delete(activityId)
  try {
    setCheckButtonBusy(false)
  } catch {}
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
  try {
    window.LiaLLM?.showFeedback?.(
      feedbackId,
      visibleFeedback?.message ?? "",
      displayOptions
    )
  } catch {}
}

function stoppedError() {
  const error = new Error("Die Sprachprüfung wurde beendet.")
  error.name = "AbortError"
  return error
}

function finishQuiz(value) {
  if (!active || finished) return
  finished = true
  releaseQuizRun()
  clearActivity()
  send.lia(value)
}

function finishUnassessed(message) {
  if (!active || finished) return
  finished = true
  releaseQuizRun()
  clearActivity()
  clearSolutionVariant()
  try {
    window.LiaLLM?.showFeedback?.(feedbackId, "")
  } catch {}
  send.lia(message, [], false)
}

function finishTechnicalError(error) {
  const message = error instanceof Error ? error.message : String(error)
  finishUnassessed(message)
}

function abortEvaluation() {
  if (finished) return
  active = false
  finished = true
  evaluationController.abort()
  releaseQuizRun()
  clearActivity()
  clearSolutionVariant()
  try {
    window.LiaLLM?.showFeedback?.(feedbackId, "")
  } catch {}
  return true
}

function restoreCheckButtonFocus() {
  if (activeCheckButton?.isConnected && !activeCheckButton.disabled) {
    try {
      activeCheckButton.focus({ preventScroll: true })
    } catch {}
  }
}

function stopEvaluation() {
  abortEvaluation()
}

function stopWaitingState() {
  if (typeof send.stop === "function") send.stop()
  else send.lia("LIA: stop")
}

function supersedeEvaluation() {
  if (!abortEvaluation()) return
  stopWaitingState()
}

function cancelEvaluation() {
  if (!abortEvaluation()) return
  stopWaitingState()
  restoreCheckButtonFocus()
  if (typeof queueMicrotask === "function") {
    queueMicrotask(restoreCheckButtonFocus)
  }
}

Promise.resolve()
  .then(() => {
    const previousQuizRun = activeQuizRuns.get(activityId)
    if (typeof previousQuizRun === "function") previousQuizRun()
    checkButtonInitialDisabled = activeCheckButton?.disabled ?? false
    checkButtonInitialAriaBusy =
      activeCheckButton?.getAttribute("aria-busy") ?? null
    activeQuizRuns.set(activityId, supersedeEvaluation)
    setCheckButtonBusy(true)
    try {
      window.LiaLLM?.showFeedback?.(feedbackId, "")
      window.LiaLLM?.showActivity?.(
        activityId,
        runId,
        "selecting-model",
        { onCancel: cancelEvaluation }
      )
      window.LiaLLM?.setSolutionVariant?.(solutionVariantId, runId)
    } catch {}
    send.handle("stop", stopEvaluation)

    if (!window.LiaLLM) {
      throw new Error("lia-llm konnte nicht geladen werden.")
    }
    if (window.LiaLLM.version !== "0.6.5") {
      throw new Error(`lia-llm 0.6.5 wird benötigt; geladen ist ${window.LiaLLM.version}.`)
    }

    const options = window.LiaLLM.parseMacroOptions(optionSource)
    quizOptions = options
    criteriaBlock = window.LiaLLM.parseCriteriaBlock(referenceSource) ?? null
    if (options.coverage !== undefined && !criteriaBlock) {
      throw new Error(
        "Die Option coverage ist nur mit einem Kriterienblock zulässig."
      )
    }
    evaluationCriteria =
      options.coverage === undefined
        ? criteriaBlock?.criteria
        : criteriaBlock.criteria.map(criterion => ({
            ...criterion,
            required: false
          }))
    evaluationThresholds = {
      criterionThreshold: options.passThreshold,
      ...(options.coverage !== undefined
        ? { passThreshold: options.coverage }
        : {})
    }
    referenceVariants = window.LiaLLM.parseReferenceVariants(
      criteriaBlock?.reference ?? referenceSource
    )
    feedbackEnabled = options.feedback
    if (criteriaBlock && options.operator) {
      throw new Error(
        "Der atomare Aussagenabgleich prüft Inhalte ohne technischen Operator. Entferne operator=...; das Operatorwort darf im Aufgabenwortlaut stehen bleiben."
      )
    }
    return window.LiaLLM.evaluate({
      question,
      answer,
      reference: referenceVariants[0],
      referenceVariants: referenceVariants.slice(1),
      assessmentEngine: options.assessmentEngine,
      operator: options.operator ?? undefined,
      criteria: evaluationCriteria,
      ...evaluationThresholds
    }, {
      signal: evaluationController.signal,
      maxThinkingTimeMs: options.maxThinkingTimeMs,
      maxThinkingTokens: options.maxThinkingTokens,
      onProgress: progress => {
        if (!active || finished) return
        window.LiaLLM?.showActivity?.(activityId, runId, progress.phase, {
          message: progress.message,
          thinkingTimeLimitMs: progress.thinkingTimeLimitMs,
          thinkingTimeRemainingMs: progress.thinkingTimeRemainingMs,
          onCancel: cancelEvaluation
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
      try {
        window.LiaLLM?.setSolutionVariant?.(
          solutionVariantId,
          runId,
          selectedReferenceIndex
        )
      } catch {}
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
                criteria: evaluationCriteria,
                ...evaluationThresholds,
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
Auswertung anhand einer Musterlösung. Dafür steht das öffentliche Makro
`@LLMQuiz(Optionen,Aufgabenwortlaut)` zur Verfügung.

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
Der echte Aufgabenwortlaut wird als zweiter Makroparameter an die Auswertung übergeben.

### Aufruf und Optionen

Der Makroaufruf steht in derselben Zeile wie die öffnenden drei Backticks des `text`-Blocks. Die
Grundform lautet ``@LLMQuiz(Schwellenwert[;Optionen],`Aufgabenwortlaut`)``.

Der erste Makroparameter beginnt immer mit dem verpflichtenden Schwellenwert. Weitere Optionen
folgen darin, jeweils durch ein Semikolon getrennt. Der zweite Makroparameter ist der vollständige
Aufgabenwortlaut. Backticks schützen ihn vor einer versehentlichen Trennung an Kommas und sind
deshalb auch bei kurzen Aufgaben empfehlenswert. Der Inhalt des anschließenden `text`-Blocks ist
die Musterlösung oder der Kriterienblock.

| Eintrag | Zulässige Werte | Standard | Bedeutung |
| --- | --- | --- | --- |
| `Schwellenwert` | Dezimalzahl von `0` bis `1`, mit Punkt | Pflichtangabe; empfohlen meist `0.66`, bei atomaren Kriterien `0.55` | Mindestkonfidenz für die gesamte Musterlösung beziehungsweise für jedes einzelne Kriterium; keine Gesamtquote |
| `solution` | `0`, `1`, `false`, `true` | `true` | Zeigt die Musterlösung nach einer richtigen Antwort an; bei `false` bleibt sie immer verborgen |
| `feedback` | `0`, `1`, `false`, `true` | `false` | Schaltet eine kurze, priorisierte Rückmeldung ein; für die Sprachoptionen muss `feedback` aktiv sein |
| `operator` | `erklaeren`, `erlaeutern`, `beschreiben`, `begruenden`, `vergleichen`, `beurteilen` | nicht gesetzt | Prüft zusätzlich die verlangte Antwortform; nicht mit einem Kriterienblock oder ausdrücklich gewähltem `compact` kombinierbar |
| `coverage` | Dezimalzahl mit `0 < coverage <= 1`, mit Punkt | nicht gesetzt | Aktiviert nur bei einem Kriterienblock eine gewichtete Gesamtquote; ohne die Option bleiben alle Kriterien einzeln erforderlich, ein Widerspruch bleibt immer ein Veto |
| `assessmentengine` | `compact`, `quality` | automatisch | Wählt die Engine der Inhaltsprüfung; normale Prüfungen verwenden `compact`, Operator- oder positive Thinking-Vorgaben `quality` |
| `Rechtschreibung` | `0`, `1`, `false`, `true` | `false` | Bietet nach der Inhaltsprüfung eine getrennte Prüfung von Rechtschreibung und Zeichensetzung an; benötigt `feedback=1` |
| `Satzbau` | `0`, `1`, `false`, `true` | `false` | Bietet nach der Inhaltsprüfung eine getrennte Prüfung von Grammatik und Satzbau an; benötigt `feedback=1` |
| `maxthinkingtime` | `0s`, `5s`, `10s`, `15s`, `20s`, `30s` | im adaptiven Zweitlauf `15s` | Begrenzt ausschließlich die zusätzliche Denkzeit, nicht Modellstart oder Grundprüfung; `0s` deaktiviert den Thinking-Lauf |
| `maxthinkingtokens` | `low`, `medium`, `high`, `ultra`, `extreme` | im adaptiven Zweitlauf `medium` | Begrenzt das Thinking-Ausgabebudget auf 256, 512, 768, 1024 beziehungsweise 2048 Tokens |

Mit den Standardwerten für alle optionalen Einträge genügt die Minimalform
``@LLMQuiz(0.66,`Beschreibe den Verlauf.`)``. Die empfohlene benannte Form lautet beispielsweise
``@LLMQuiz(0.66;solution=1;feedback=1,`Beschreibe den Verlauf.`)``.

Für `solution`, `feedback` und `operator` existiert zusätzlich die Kurzform in genau dieser
Reihenfolge: ``@LLMQuiz(0.66;1;1;beschreiben,`Beschreibe den Verlauf.`)``.

Alle übrigen Optionen sind nur benannt verfügbar. Optionsnamen sind nicht von Groß- und
Kleinschreibung abhängig und dürfen in beliebiger Reihenfolge stehen. Benannte und positionale
Optionen dürfen innerhalb eines Aufrufs nicht gemischt werden. Leere, unbekannte oder doppelte
Optionen werden mit einer Fehlermeldung abgewiesen. `assessmentengine=compact` ist nicht mit einem
Operator oder aktivem Thinking kombinierbar; `maxthinkingtime=0s` bleibt zulässig.
`Rechtschreibung` und `Satzbau` starten erst nach dem abgeschlossenen Inhaltsurteil einen eigenen
Quality-Lauf und verändern das Inhaltsurteil nicht.
Aufrufe aus älteren Ständen, die `@LLMQuiz` nur einen Optionsparameter übergeben, müssen um den
Aufgabenwortlaut als zweiten Parameter ergänzt werden.

Ein vollständiger Aufruf sieht so aus:

```` markdown
Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66;solution=1;feedback=1;assessmentengine=quality;operator=erklaeren;maxthinkingtime=15s;maxthinkingtokens=medium,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
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
```text @LLMQuiz(0.66;solution=1;feedback=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
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

Soll eine freie Antwort nicht nur als Ganzes, sondern gegen mehrere atomare Kerninformationen
geprüft werden, beginnt jede Aussage mit der allein stehenden Kommentarzeile
`<!-- lia-llm:criterion -->`. Der erste Marker muss zugleich die erste nichtleere Zeile des
Erwartungshorizonts sein. Ohne einen solchen Marker bleibt der bisherige ganzheitliche Vergleich
unverändert aktiv.

```` markdown
Aufgabe: Warum hält Leyla Finn davon ab, die Blechdose aufzubrechen? Erkläre außerdem, was die
unterschiedlichen Reaktionen über ihre Arbeitsweisen zeigen.

<!-- data-solution-button="off" data-llm-textarea="6" -->
[[Antwort]]
```text @LLMQuiz(0.55;solution=1;feedback=1,`Warum hält Leyla Finn davon ab, die Blechdose aufzubrechen? Erkläre außerdem, was die unterschiedlichen Reaktionen über ihre Arbeitsweisen zeigen.`)
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
Die vom Makro gelesenen Kriterien sind gleich gewichtet. Ohne die Option `coverage` sind sie wie
bisher alle einzeln erforderlich: Die Antwort besteht nur, wenn jede Kerninformation erfüllt ist.
Dieses Legacy-Verhalten gilt unverändert für alle vorhandenen Aufrufe. Ein Kriterium soll genau eine
selbstständig prüfbare fachliche Aussage enthalten. Unabhängige Behauptungen werden getrennt;
deshalb bilden im Beispiel „sorgfältig“, „geduldig“ und „aufmerksam“ drei Kriterien und keine
Aufzählung in einem Sammelkriterium.

Mit `assessmentengine=quality` wird jedes atomare Kriterium ausdrücklich als `einzelkriterium`
geprüft. Die vollständige Lernendenantwort dient dabei als Belegtext; die vollständige Aufgabenfrage
liefert nur den Kontext. Andere Anforderungen aus der Frage – etwa eine bestimmte Reihenfolge oder
ein weiterer, nicht im aktuellen Kriterium genannter Bildbereich – dürfen den Einzelentscheid nicht
beeinflussen. Das unterscheidet den Kriterienmodus von einer ganzheitlichen Musterlösung: Dort wird
weiterhin die `gesamtantwort` geprüft, und die wesentlichen Anforderungen müssen insgesamt
vollständig genug erfüllt sein.

Eine fehlende oder nicht eindeutig belegte Information führt beim Quality-Judge zu
`fail_incomplete`, nicht zu `fail_contradiction`. Ein Widerspruch liegt nur vor, wenn die Antwort eine
ausdrückliche, logisch unvereinbare Gegenbehauptung zum aktuellen Kriterium enthält. Eine plausible
oder unscharfe Zuordnung wie „Bildmitte“ gegenüber „Hintergrund“ ist daher kein Widerspruch. Formale
Kriterien wie Präsens werden direkt am Antworttext geprüft. Abwesenheitskriterien wie „keine
erfundene Geschichte“ sind erfüllt, wenn der verbotene Inhalt fehlt; die Regel muss in der Antwort
nicht eigens erwähnt werden.

Passende Belege für dasselbe Einzelkriterium dürfen über mehrere Sätze der vollständigen
Lernendenantwort verteilt sein. Eine Formulierung wie „mindestens ein X, etwa A oder B“ wird
wörtlich als Auswahl gelesen: Ein passendes Beispiel genügt; nicht gewählte Beispiele gelten weder
als fehlend noch als widersprochen. „Etwa“ allein hebt dagegen keine verlangte Anzahl auf. Die
Hauptformulierung eines Kriteriums und ausdrücklich hinterlegte gleichwertige Varianten haben
ODER-Bedeutung.

Die intern verwendete `confidence` bezeichnet die Sicherheit, dass die gewählte Entscheidung
fachlich richtig ist, nicht den Erfüllungsgrad der Lernendenantwort. Deshalb erhält auch ein
eindeutig erkannter Widerspruch eine hohe Konfidenz. Eine bloß fehlende Aussage bleibt
`fail_incomplete`; nur eine ausdrückliche logisch unvereinbare Gegenbehauptung ist
`fail_contradiction`.

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

#### Gesamtquote mit `coverage`

Die benannte Option `coverage` aktiviert ausdrücklich einen zweiten, davon unabhängigen
Schwellenwert. Der erste Zahlenwert entscheidet weiterhin, ab welcher Konfidenz **jedes einzelne**
Kriterium als erfüllt gilt. `coverage=0.80` verlangt anschließend eine gewichtete Gesamtquote von
mindestens 80 Prozent erfüllter Kriterien. Der erste Zahlenwert ist also keine Gesamtquote.

Ein vollständiger Aufruf mit elf Kriterien sieht beispielsweise so aus:

```` markdown
Aufgabe: Beschreibe die Eigenschaften eines Quadrats.

<!-- data-solution-button="off" data-llm-textarea="6" -->
[[Antwort]]
```text @LLMQuiz(0.55;coverage=0.80;solution=1;feedback=1;assessmentengine=quality;Rechtschreibung=1;Satzbau=1,`Beschreibe die Eigenschaften eines Quadrats.`)
<!-- lia-llm:criterion -->
Ein Quadrat hat vier Seiten.
<!-- lia-llm:criterion -->
Alle vier Seiten sind gleich lang.
<!-- lia-llm:criterion -->
Ein Quadrat hat vier Eckpunkte.
<!-- lia-llm:criterion -->
Alle vier Innenwinkel sind rechte Winkel.
<!-- lia-llm:criterion -->
Je zwei gegenüberliegende Seiten sind parallel.
<!-- lia-llm:criterion -->
Die beiden Diagonalen sind gleich lang.
<!-- lia-llm:criterion -->
Die Diagonalen halbieren einander.
<!-- lia-llm:criterion -->
Die Diagonalen stehen senkrecht aufeinander.
<!-- lia-llm:criterion -->
Jede Diagonale halbiert zwei Innenwinkel.
<!-- lia-llm:criterion -->
Jedes Quadrat ist ein Rechteck.
<!-- lia-llm:criterion -->
Jedes Quadrat ist eine Raute.
<!-- lia-llm:solution -->
Ein Quadrat besitzt vier gleich lange Seiten und vier Eckpunkte. Alle vier Innenwinkel sind rechte
Winkel, und je zwei gegenüberliegende Seiten verlaufen parallel. Seine gleich langen Diagonalen
halbieren einander, stehen senkrecht aufeinander und halbieren die Innenwinkel. Daher ist jedes
Quadrat sowohl ein Rechteck als auch eine Raute.
```
````

Bei gleich gewichteten Kriterien wird die benötigte Anzahl stets aufgerundet:
`ceil(Anzahl × coverage)`. Im Beispiel müssen daher mindestens neun der elf Kriterien erfüllt
sein, weil `ceil(11 × 0.80) = 9` und `9 / 11 >= 0.80`.

| Kriterienstatus bei elf gleich gewichteten Kriterien | Gesamtergebnis bei `coverage=0.80` |
| --- | --- |
| 9 `met`, 2 `missed` | `passed` |
| 8 `met`, 3 `missed` | `failed` |
| 8 `met`, 1 `uncertain`, 2 `missed` | `uncertain` |
| ausreichende `met`-Quote, aber mindestens 1 `contradicted` | `failed` |

Im Quotenmodus blockiert ein einzelnes `missed`-Kriterium nicht; für das Bestehen zählt nur die
gewichtete Quote der `met`-Kriterien. `uncertain` zählt weder als erfüllt noch als widerlegt. Reicht
die `met`-Quote bereits aus, ist das Ergebnis `passed`. Reicht sie nicht aus, könnte aber zusammen
mit allen `uncertain`-Kriterien die Grenze erreichen, bleibt das Ergebnis `uncertain` und wird nicht
als richtig gewertet. Reicht auch diese potenzielle Quote nicht aus, ist es `failed`. Jedes
`contradicted`-Kriterium bleibt unabhängig von der Quote ein Veto und führt zu `failed`.

`coverage` ist case-insensitiv, ausschließlich als benannte Option verfügbar und akzeptiert
Dezimalwerte mit Punkt im Bereich `0 < coverage <= 1`. Auch `coverage=1` aktiviert den Quotenmodus
ausdrücklich; ohne die Option bleibt dagegen das Legacy-Verhalten mit einzeln erforderlichen
Kriterien aktiv. Die Option ist nur zusammen mit einem Kriterienblock zulässig. Bei einer
ganzheitlichen Musterlösung wird der Aufruf vor der Modellprüfung mit einer Fehlermeldung beendet.

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

### Adaptiver Denkmodus

Das Qualitätsmodell bewertet zunächst kurz und strukturiert. Bei atomaren Kriterien werden bis zu
acht Kriterien in einem gemeinsamen Erstdurchlauf geprüft, aber weiterhin einzeln und fail-closed
zugeordnet. Eine Antwort wie im Fall `5_09` benötigt deshalb nicht mehr acht serielle
Qwen-Aufrufe. Liefert der Batch unsichere Einzelentscheidungen, wird zunächst höchstens das anhand
der Antwort relevanteste unsichere Kriterium noch einmal ohne Thinking einzeln geprüft. Ein dabei
bestätigter Widerspruch beendet die fachliche Prüfung sofort. Nur wenn danach noch eine vertiefte
Prüfung sinnvoll ist, dürfen höchstens zwei relevante Kriterien das gemeinsame Thinking-Budget
verwenden.

Ist ein Ergebnis grenznah oder `uncertain`, umfasst die Antwort mindestens 160 Wörter oder ist
eine Operatorantwort ab 24 Wörtern zu prüfen, kann ein zusätzlicher Thinking-Lauf folgen. Dafür
gelten grundsätzlich `maxthinkingtime=15s` und `maxthinkingtokens=medium`. Ab 160 Wörtern wird
jede nicht ausdrücklich gesetzte Dimension adaptiv auf `maxthinkingtime=30s` beziehungsweise
`maxthinkingtokens=ultra` angehoben. Eine explizit gesetzte Zeit oder Tokenstufe bleibt jeweils
erhalten; nur die jeweils fehlende Angabe wird automatisch ergänzt.

Die Zeitangabe begrenzt nur den zusätzlichen Thinking-Lauf nach dem schnellen Erstdurchlauf; Laden,
Initialisieren und die Grundprüfung des Modells zählen nicht dazu. Bei Ablauf wird die laufende
Generierung kooperativ unterbrochen und das Ergebnis des Thinking-Laufs verworfen. Die Oberfläche
wird sofort freigegeben; intern darf der WebLLM-Aufruf noch höchstens zehn Sekunden kontrolliert
auslaufen, bevor ein festhängender Worker hart beendet wird. Ein unmittelbar gestarteter neuer Lauf
wartet diese kurze Bereinigung ab und verwendet den intakten Worker anschließend weiter. Bereits an
die GPU übergebene Arbeit kann währenddessen technisch noch kurz auslaufen. `0s` deaktiviert sowohl
den optionalen Einzelrecheck als auch den Thinking-Lauf. Die Tokenpresets entsprechen
`low=256`, `medium=512`, `high=768`,
`ultra=1024` und `extreme=2048`. Dieses Gesamt-Completion-Budget umfasst sowohl den internen
`<think>`-Block als auch das abschließende JSON und gilt als gemeinsames Budget für die gesamte
Antwort, nicht erneut pro Kriterium. `ultra` ist nur für leistungsfähige Geräte gedacht;
`extreme` ist eine experimentelle Desktop-Option und keine Empfehlung für Schulgeräte.

Unabhängig vom Thinking-Budget verhindert der Quality-Worker endlose einzelne Modellaufrufe mit
technischen Obergrenzen: Die Worker-Initialisierung wird nach 120 Sekunden und jede einzelne
Modell-Completion der Grundprüfung nach 150 Sekunden hart beendet. Die 150 Sekunden sind deshalb
keine Obergrenze für die gesamte Prüfung, falls diese mehrere Completions benötigt. Ein solcher
Timeout verwirft den Worker, sperrt Quality aber nicht dauerhaft; eine erneute Prüfung startet einen
frischen Worker aus dem vorhandenen Cache.

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
Für `operator=...` muss der echte Aufgabenwortlaut als zweiter Parameter von `@LLMQuiz` übergeben
werden, weil daraus sein konkreter Umfang folgt. Der Operator wird nicht heimlich aus einem Verb erkannt und nicht
pauschal einem Anforderungsbereich zugeordnet. Die fachliche Grundlage steht in
[Operatoren.md](Operatoren.md), die technische Matrix in [docs/operatoren.md](docs/operatoren.md).

Operatoraufgaben bestehen erst nach der Prüfung durch das Qualitätsmodell. Das Kompaktmodell darf
den Fachinhalt vorprüfen, aber die verlangte Antwortform nicht allein freigeben. Ist die
Qualitätsprüfung etwa ohne WebGPU oder nach einem Modellfehler nicht verfügbar, wird ein sonst
ausschließlich verfügbarer Kompaktbefund zu `uncertain` und bittet um eine erneute Prüfung.
Da ohne das erforderliche Modell die Gesamtaufgabe einschließlich ihrer Antwortform nicht
zuverlässig geprüft ist, wird der Versuch weder als richtig noch als fachlich falsch verbucht.

Der native LiaScript-Lösungsbutton bleibt bei dieser Quizform ausgeschaltet; die sichtbare Ausgabe
wird ausschließlich über `solution` gesteuert. Soll die Musterlösung nie erscheinen:

```` markdown
<!-- data-solution-button="off" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66;solution=0;feedback=1,`Beschreibe den Verlauf.`)
Hier steht weiterhin die vollständige Musterlösung für den lokalen Vergleich.
```
````

`solution=0` ist kein Zugriffsschutz: Die lokale Auswertung benötigt die Musterlösung, deshalb
bleibt sie im Kursquelltext und im Browser auffindbar.

### Mehrzeilige Antworten

`data-llm-textarea="5"` erzeugt ein vergrößerbares Feld mit fünf sichtbaren Zeilen. Werte von 2 bis
12 sind möglich, auch innerhalb von `dynFlex`-Spalten und anderen verschachtelten Containern.
Absätze und Leerzeilen bleiben bei der Auswertung erhalten. Im Feld bleiben alle
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
```text @LLMQuiz(0.66;solution=1;feedback=1;operator=erklaeren;Rechtschreibung=1;Satzbau=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
Eis besitzt eine geringere Dichte als flüssiges Wasser. Beim Gefrieren entsteht eine
offene Kristallstruktur, die mehr Volumen einnimmt.
```
````

Der echte Aufgabenwortlaut steht bei `@LLMQuiz` nach dem Komma als zweiter
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
beendet einen noch laufenden optionalen Sprachjob. Bereits vollständig geladene Cache-Artefakte
bleiben erhalten. Eine noch laufende gemeinsame Quality-Vorbereitung läuft nur weiter, solange
mindestens ein anderer aktiver Inhalts- oder Sprachlauf auf sie wartet; andernfalls wird sie
abgebrochen.

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
6. Während einer laufenden Auswertung ist der zugehörige **Prüfen**-Button gesperrt; die sichtbare
   Aktivitätsanzeige bietet stattdessen **Prüfung abbrechen** an. Der Abbruch beendet die laufende
   Prüfung und gibt das Quiz mit `LIA: stop` ohne neues richtig/falsch-Ergebnis frei. Während einer
   Quality-Auswertung wird die aktive Generierung zuerst kooperativ unterbrochen und kontrolliert
   auslaufen gelassen, damit der WebGPU-Zustand für den nächsten Versuch erhalten bleibt. Nur wenn
   der Aufruf innerhalb von zehn Sekunden nicht endet oder noch die Worker-Vorbereitung läuft, wird
   der isolierte Worker hart beendet. Wird derselbe Makrolauf technisch trotzdem erneut ausgelöst,
   beendet der neue Lauf zuerst den Wartezustand seines Vorgängers und wartet nötigenfalls auf diese
   Bereinigung. Bereits an die GPU übergebene Arbeit kann dabei noch kurz auslaufen. Ein bereits
   gestarteter Kompaktlauf kann aufgrund der zugrunde liegenden WASM-Laufzeit ebenfalls technisch zu
   Ende laufen, liefert nach dem Abbruch aber kein verspätetes Quizresultat.

Wurde `assessmentengine=quality` ausdrücklich für atomare Kriterien angefordert, ist ein
`failed`- oder `uncertain`-Befund des Kompaktmodells bei nicht verfügbarer Quality-Prüfung kein
abschließendes fachliches Urteil. Das Gesamtergebnis bleibt in diesem Fall `uncertain`, `passed`
bleibt `false`, und die Diagnose `quality-check-unavailable` fordert zu einer erneuten Prüfung mit
verfügbarem Quality-Modell auf. Ein tatsächlich erzeugter Quality-Befund wird nicht abgeschwächt:
Insbesondere bleibt ein dort festgestelltes `contradicted` unabhängig von `coverage` ein hartes Veto.

| Stufe | Modell und Laufzeit | Erster Download | Einordnung |
| --- | --- | ---: | --- |
| Qualität (Standard, Opt-in) | Qwen3-1.7B über WebLLM | ca. 984 MB | erprobte, ressourcenschonende Quality-Stufe; benötigt WebGPU |
| Qualität (experimentell) | Qwen3-4B über WebLLM | ca. 2,28 GB (2,12 GiB) | wird nicht automatisch neu heruntergeladen; kann nur als vollständig vorhandener Cache-Fallback dienen, die öffentliche Makro-API bietet keine Large-Auswahl |
| sicherer Standard/Fallback | mDeBERTa-v3 NLI über Transformers.js | ca. 379 MB inklusive ONNX-Laufzeit | normale Engine ohne Quality-Opt-in; läuft bei Bedarf mit WASM |

Beim standardmäßigen WASM-Start laufen ONNX-Sitzung und Inferenz des
Kompaktmodells in einem Worker. Dadurch blockiert die automatische Vorbereitung nicht den
LiaScript-UI-Thread. Einbettende Seiten müssen dafür die unter
`test/BROWSER-HARDENING.md` dokumentierte `worker-src`-/Blob-CSP erlauben.

Vor jedem noch nicht vollständig gecachten Quality-Download wertet das Template, soweit verfügbar,
`navigator.storage.estimate()` aus. Bei gültiger `quota` und `usage` gilt als frei
`quota - usage`; zusätzlich bleibt eine Reserve von `max(512 MiB, 10 % der quota)` unangetastet.
Qwen3-1.7B wird als verlässlicher Standard gewählt, sobald seine 984.000.000 B plus Reserve frei
sind oder seine Gewichte bereits im Cache liegen. Reicht ein bekanntes Budget nicht einmal dafür,
startet kein neuer Quality-Download. Fehlt die Storage-API, schlägt sie fehl oder liefert sie keine
belastbaren Werte, bleibt 1.7B die konservative Auswahl. Qwen3-4B wird standardmäßig nicht neu
heruntergeladen. Ein bereits vollständig vorhandenes 4B-Modell kann als Fallback wiederverwendet
werden, wenn 1.7B nicht sicher zusätzlich Platz findet. Der interne Selektor hält einen
Large-Pfad für Tests und mögliche Integrationen vor; die öffentliche Makro-API stellt diese
Auswahl derzeit nicht bereit.

Auch bei einer für diese Herkunft gemeldeten Quote von 4.000.000.000 B bleibt 1.7B der
Produktionsstandard. Erhöht eine Schulrichtlinie nur den allgemeinen HTTP-Diskcache, ohne die von
`navigator.storage.estimate()` gemeldete Origin-Quote zu erhöhen, bleibt für die Zulässigkeit
eines Downloads der niedrigere Browserwert maßgeblich. Alle Werte sind Schätzungen; ein späteres
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

Auf dem lokal getesteten Edge-151-System mit einer RTX 2070 SUPER verlor die unveränderte
WebLLM-0.2.84-Laufzeit mit Qwen3-1.7B in vier von vier warmen Minimalläufen das GPU-Gerät
(`DXGI_ERROR_DEVICE_HUNG`). Seit Version 0.6.3 enthält das Template deshalb eng an diese gepinnte Laufzeit gebundene
Kompatibilitätskorrekturen: Unveränderliche Shape-Tuples bleiben bis zum Abbau der Engine gültig,
ausstehende GPU-zu-CPU-Readbacks werden auch bei nachfolgender Queue-Arbeit vollständig abgewartet
und ein WebGPU-Command-Buffer wird auf höchstens 32 Compute-Pässe begrenzt.

Mit diesem Stand bestanden auf demselben Host ein Cold- und zwei Warm-Direktläufe mit
Qwen3-1.7B. Der exakte Kriterienfall `5_09` bestand mit Version 0.6.4 beide Prüffälle in rund
53 Sekunden reiner Auswertungszeit statt zuvor rund 139 Sekunden: Die gemeldete Antwort benötigte
25.655 ms und erfüllte 8 von 8 Kriterien; die
ausdrückliche Gegenbehauptung wurde nach einem gezielten Einzelrecheck am Himmelskriterium als
Widerspruch abgewiesen. Die beiden Batchdurchläufe und der eine Recheck endeten ohne GPU-,
Grammar- oder Parserfehler. Das ist ein gezielter Nachweis für diesen 1.7B-Lauf auf diesem Host,
aber noch keine allgemeine Freigabe: Qwen3-4B, der vollständige
Cold→Neustart→Offline→Clear-Ablauf und die tatsächlichen Schulgeräte bleiben separat zu prüfen.

Version 0.6.5 wurde zusätzlich im sichtbaren offiziellen LiaScript-Renderer mit Edge 152 und
Firefox 155.0.1, jeweils mit normalem WebGPU und einem warmen 1.7B-Cache, geprüft. Abbruch und
unmittelbarer Neustart sowie ein technisch erzwungener Ersatzlauf hinterließen in beiden Browsern
keinen aktiven Quizlauf und keine sichtbare Ladeanzeige; die erfolgreichen `5_09`-Läufe erfüllten
jeweils 8 von 8 Kriterien. Ein gezielt erzwungener Thinking-Lauf endete in Edge nach 15.002 ms und
in Firefox nach 15.072 ms. Beide Browser sendeten genau einen kooperativen
`interruptGenerate`-Aufruf, beendeten den Quality-Worker dabei nicht und verwendeten ihn für den
sofort folgenden erfolgreichen 8-von-8-Lauf weiter. Die gesamte erste Prüfung dauerte dennoch
43.802 ms beziehungsweise 120.975 ms, weil Modellstart und Grundprüfung – wie oben beschrieben –
nicht zum 15-Sekunden-Thinking-Budget gehören.

Die zwischenzeitlich geprüfte 0.6B-Variante bestand den semantischen Stresstest nur in 6 von 12
Fällen und wird nicht als Bewertungsmodell ausgeliefert.

Seit Version 0.5.14 entfernt das Template vor einem neuen Quality-Download die exakt gepinnten
ausgehenden Qwen3-0.6B-Artefakte. Der normale 1.7B-Standard entfernt kein vorhandenes
Qwen3-1.7B zugunsten eines automatischen 4B-Upgrades. Der entsprechende Large-Pfad ist nur
intern für Tests und mögliche Integrationen reserviert; die öffentliche Makro-API exponiert ihn
nicht. Ansonsten bleiben die aktiven
Quality-Artefakte und fremde WebLLM-Cacheeinträge erhalten.

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
180 Sekunden. Danach greift der jeweils vorgesehene Kompakt- beziehungsweise `uncertain`-Fallback.
Hat dieser Zeit-Fallback die globale Quality-Vorbereitung bereits bewusst vom Quiz gelöst, läuft sie
sichtbar bis zum vollständigen Cache weiter; ein späteres Ende dieses bereits abgeschlossenen
Quizlaufs bricht den losgelösten Hintergrunddownload nicht ab. Wird eine noch wartende Prüfung
dagegen ausdrücklich abgebrochen, endet auch ihre Quality-Vorbereitung, sobald kein anderer aktiver
Lauf mehr auf dieselbe Vorbereitung wartet.

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
`DXGI_ERROR_DEVICE_RESET`, `Buffer unmapped`, `Buffer is not mapped`, ein bereits
freigegebenes (`disposed`) Engine-Objekt oder GPU-Speichermangel schaltet das Qualitätsmodell
dagegen für die laufende Sitzung ab. So wird ein zerstörter GPU-Zustand nicht erneut verwendet;
der nun vollständige Modellcache bleibt für einen späteren Seitenaufruf erhalten und der
Kompakt-Fallback bleibt verfügbar. Rohe WebGPU-Meldungen werden nicht als Lernendenfeedback
ausgegeben. Am Quiz erscheint stattdessen eine verständliche Meldung zur nicht verfügbaren
Modellprüfung; bei einem direkt gemeldeten Laufzeitfehler empfiehlt sie einen Seiten- und bei
wiederholtem Auftreten einen Browserneustart.

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
Speicherplatz. WebGPU-Geräteverlust, die genannten DXGI-Fehler, nicht mehr gemappte Puffer
(`Buffer unmapped`), GPU-Speichermangel und Meldungen über bereits freigegebene Objekte werden als
Laufzeitfehler ausgewiesen. `Object has already been disposed` und `Buffer unmapped` können
Folgefehler eines zuvor verlorenen GPU-Geräts sein und sind kein Hinweis auf zu wenig freien
Browser-Speicherplatz. Eine nicht nach dem JSON-Vertrag validierbare Quality-Entscheidung wird
getrennt als `quality-output-invalid` und nicht als beschädigtes Modellartefakt eingeordnet.
Ein Abbruch der strukturierten Runtime-/Grammatikprüfung erhält den eigenen Befund
`quality-runtime-failed`.
Wo der Browser mehrere Ursachen nicht unterscheiden kann, wird die Einordnung ausdrücklich als
Vermutung gekennzeichnet.

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
```text @LLMQuiz(0.66;solution=1;feedback=1;assessmentengine=compact;Rechtschreibung=1;Satzbau=1,`Erkläre, warum Eis auf flüssigem Wasser schwimmt.`)
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

Beim Folienwechsel beendet der Makro-`stop`-Handler die Ausgabe und die aktive Auswertung der
verlassenen Aufgabe. Vollständig geladene Cache-Artefakte bleiben erhalten. Eine noch gemeinsam
genutzte Quality-Vorbereitung läuft für andere aktive Aufgaben weiter; ohne weiteren Interessenten
wird sie abgebrochen. Nur eine nach dem oben beschriebenen Zeit-Fallback bereits bewusst losgelöste
Hintergrundvorbereitung läuft unabhängig vom beendeten Quiz weiter. Dadurch erscheint kein
verspätetes Quizresultat auf einer anderen Folie; ein bereits vorbereitetes Modell steht für spätere
Aufgaben weiterhin zur Verfügung.
