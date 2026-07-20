<!--
author:      MINT-the-GAP, Martin Lommatzsch
version:     0.0.1
language:    de
narrator:    Deutsch Female
comment:     Lokale NLI-Auswertung normaler LiaScript-Freitextquizze anhand einer Musterlösung.
repository:  https://github.com/MINT-the-GAP/lia-llm
script:      ./dist/index.js

attribute:   [Transformers.js](https://huggingface.co/docs/transformers.js/)
             by Hugging Face is licensed under [Apache-2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE)
             and [multilingual mDeBERTa-v3 NLI](https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7)
             by Moritz Laurer, converted for Transformers.js by Xenova, is licensed under
             [MIT](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7/blob/main/LICENSE).

@LLMQuiz
<script>
const criterionThreshold = Number(`@'0`)
const reference = `@'1`
const answer = `@'input`.replace(/\u2028/gu, "\n")

Promise.resolve()
  .then(() => {
    if (!window.LiaLLM) {
      throw new Error("lia-llm konnte nicht geladen werden.")
    }
    if (window.LiaLLM.version !== "0.3.1") {
      throw new Error(`lia-llm 0.3.1 wird benötigt; geladen ist ${window.LiaLLM.version}.`)
    }

    return window.LiaLLM.evaluate({
      question: "LiaScript-Freitextaufgabe",
      answer,
      reference,
      criterionThreshold
    })
  })
  .then(result => send.lia(String(result.passed)))
  .catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    send.lia(message, [], false)
  })

"LIA: wait"
</script>
********************************************************************************
@1
********************************************************************************
@end
-->

# lia-llm

    --{{0}}--
`lia-llm` ergänzt ein **normales LiaScript-Freitextquiz** um eine lokale semantische
Auswertung. Das Makro erzeugt weder die Frage noch das Quiz. Ein gekennzeichnetes
LiaScript-Textquiz erhält automatisch ein mehrzeiliges Antwortfeld und wird über den
angehängten Lösungsblock mit `@LLMQuiz` verbunden.

Das mehrsprachige NLI-Modell mDeBERTa-v3 vergleicht die vollständige Lernendenantwort mit der
vollständigen Musterlösung als zusammenhängende Texte. Es prüft, ob die Musterlösung aus der
Antwort **folgt**, offenbleibt oder ihr **widersprochen** wird. Sätze und Absätze sind in der
Standardauswertung ausdrücklich keine eigenständigen Kriterien oder Punkte. Damit werden
insbesondere Verneinungen und umgekehrte Aussagen gezielter behandelt als mit reiner
Textähnlichkeit. Beim ersten Prüfen wird das Modell automatisch geladen. Das ist für formative
Selbsttests gedacht und keine automatische Prüfungsnote.

## Import

Aktueller Entwicklungsstand:

``` markdown
<!--
import: https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/main/README.md
-->
```

Nach Veröffentlichung des ersten Tags sollte ein Kurs für reproduzierbare Ergebnisse die
Version fest angeben:

``` markdown
<!--
import: https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/0.0.1/README.md
-->
```

## Verwendung

Zuerst wird ein gewöhnliches LiaScript-Textquiz geschrieben. Direkt danach folgt ein Textblock,
dessen öffnende Zeile mit `@LLMQuiz(0.66)` markiert ist:

```` markdown
<!-- data-solution-button="3" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66)
Hier steht die vollständige Musterlösung.
```
````

| Bestandteil | Bedeutung |
| --- | --- |
| `data-llm-textarea="5"` | mehrzeiliges Antwortfeld mit zunächst fünf sichtbaren Zeilen |
| `0.66` | ganzheitlicher NLI-Zustimmungsschwellwert zwischen `0` und `1` |
| Inhalt des `text`-Blocks | fachlich erwartete Antwort und zugleich angezeigte LiaScript-Auflösung |

Für den Zahlenwert werden keine Backticks benötigt. Als Dezimaltrennzeichen muss ein Punkt
verwendet werden, beispielsweise `0.66`. Das Makro übergibt diesen Wert als
`criterionThreshold`: Je höher er ist, desto deutlicher muss die vollständige Lernendenantwort die
vollständige Musterlösung stützen.

`[[Antwort]]` bleibt dabei das normale LiaScript-Textquiz. Die Angabe
`data-llm-textarea="5"` ersetzt dessen einzeilige Darstellung durch ein vertikal
vergrößerbares Textfeld. Eine Schreibweise wie `[[___ ___ ___]]` würde das native Feld nur
breiter, aber nicht mehrzeilig machen. Die Zeilenzahl kann zwischen `2` und `12` gewählt werden.
Manuelle Zeilenumbrüche und Leerzeilen bleiben dabei auch nach einem Folienwechsel erhalten.

> **Wichtig:** Der mit `@LLMQuiz(0.66)` markierte Textblock muss unmittelbar nach
> `[[Antwort]]` stehen. Sein Inhalt wird automatisch an das Makro übergeben. Das Makro erzeugt
> daraus das angehängte Prüfscript und den nativen LiaScript-Auflösungsblock. Die Musterlösung
> wird deshalb nur einmal geschrieben; ein zusätzlicher Sternblock ist nicht nötig.

Die Frage und alle üblichen LiaScript-Einstellungen bleiben außerhalb des Makros. Beispielsweise
blendet `data-solution-button="3"` den Lösungsbutton erst nach drei Fehlversuchen ein.

Beim ersten Klick auf **Prüfen** lädt das Template das Modell automatisch. Die gepinnten
Q8-Modellartefakte umfassen rund 355 MB; die ONNX/WASM-Laufzeit kommt hinzu. Anschließend verwendet
der Browser nach Möglichkeit seinen Cache.

Dabei erscheint oben im Kurs automatisch ein Ladebalken. Solange Transformers.js noch keinen
messbaren Wert liefert, läuft er animiert; während eines Downloads zeigt er die aktuelle Datei,
übertragene Daten und Prozent an. Die Prozentzahl bezieht sich auf die jeweils angezeigte Datei,
nicht auf die Summe aller Artefakte. Nach erfolgreicher Initialisierung verschwindet die Anzeige
selbstständig. Bei einem Ladefehler bleibt sie mit **Erneut versuchen** sichtbar.

## Probieraufgabe

Der folgende Quelltext ist eine vollständige Aufgabe:

```` markdown
Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="1" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66)
Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine
geringere Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.
```
````

Hier kann die Aufgabe direkt ausprobiert werden:

Aufgabe 1: Erkläre, warum Eis auf flüssigem Wasser schwimmt.

<!-- data-solution-button="1" data-llm-textarea="5" -->
[[Antwort]]
```text @LLMQuiz(0.66)
Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine
geringere Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.
```

Eine erwartbar gute Testantwort wäre beispielsweise:

> Eis hat eine offene Kristallstruktur, benötigt dadurch mehr Platz und ist weniger dicht als
> flüssiges Wasser.

Eine klar unzureichende Testantwort wäre:

> Eis schwimmt ausschließlich deshalb, weil es kalt ist.

Eine fachlich widersprüchliche Testantwort wäre:

> Eis schwimmt, weil es eine höhere Dichte als flüssiges Wasser besitzt.

## Was geschieht beim Prüfen?

1. Das mehrzeilige Feld spiegelt die Eingabe einschließlich ihrer Absatzgrenzen verlustfrei in
   den Zustand des normalen LiaScript-Textquiz.
2. LiaScript setzt die Antwort als `@input` in das angehängte Script ein; das Makro stellt die
   Zeilenumbrüche vor der Auswertung wieder her.
3. Falls nötig, wird das Modell einmalig geladen.
4. In der Standardauswertung erhält mDeBERTa die vollständige Lernendenantwort als Prämisse und die
   vollständige Musterlösung als Hypothese. Beide werden im Gesamtzusammenhang bewertet; Sätze,
   Zeilen und Absätze bilden keine eigenen Kriterien.
5. Das Modell berechnet für dieses Textpaar die drei Klassen `entailment`, `neutral` und
   `contradiction`.
6. Der Wert aus `@LLMQuiz(0.66)` ist die Mindestkonfidenz für die ganzheitliche Zustimmung. Eine
   hinreichend sichere Gegenanzeige oder ein Widerspruch verhindert weiterhin das Bestehen.
7. Nur wenn über die JavaScript-API ausdrücklich Kriterien übergeben werden, wertet der Evaluator
   diese zusätzlich einzeln aus. Auch dann wird jedes Kriterium gegen die vollständige Antwort
   geprüft; einzelne Sätze werden nicht als voneinander unabhängige Antworten herausgepickt. Diese
   optionale Kriterienlogik gehört nicht zur Standardauswertung des Makros.
8. `send.lia("true")` oder `send.lia("false")` meldet das Ergebnis als den von LiaScript
   erwarteten String an das normale Quiz zurück.

Die intern berechneten NLI-Werte sind Modellkonfidenzen und keine Garantie fachlicher Richtigkeit.
`@LLMQuiz(0.66)` setzt den Zustimmungsschwellwert für diese Aufgabe auf `0.66`; ohne ausdrückliche
Angabe über die JavaScript-API gilt der kalibrierte Startwert `0.55`. Für Widerspruch gilt weiterhin
`0.65`; zusätzlich muss die entscheidende Klasse mindestens `0.15` vor den anderen Klassen liegen.
Der Widerspruchsgrenzwert ist bewusst konservativ, weil ein erkannter Widerspruch ein Veto auslöst.

Die Probieraufgabe wurde mit vollständigen Antworten im Gesamtzusammenhang kalibriert. Mit
`@LLMQuiz(0.66)` bestehen die beiden korrekten Beispielparaphrasen aus dem Regressionstest;
die sechs unvollständigen, irrelevanten oder fachlich falschen Antworten bestehen nicht. Eine nur
teilweise richtige Aussage wie „Wasser dehnt sich beim Gefrieren aus, deswegen sinkt die Dichte“
reicht dabei bewusst nicht aus, weil sie die gestellte Warum-Frage nicht vollständig beantwortet.

Die Musterlösung darf mehrere Sätze und Absätze enthalten und sollte als zusammenhängende,
fachlich vollständige Antwort formuliert sein. Zeilenumbrüche dienen nur der Formatierung und
erzeugen weder Kriterien noch Teilpunkte. Antwort und jeweilige Musterlösung werden nicht
abgeschnitten; zusammen dürfen sie höchstens 512 Modell-Token umfassen. Bei einer längeren Eingabe
meldet das Template einen Fehler, statt unbemerkt Kontext wegzulassen. Bei ausdrücklich über die
API gesetzten Kriterien sind zum Schutz vor extrem langen Auswertungen außerdem höchstens 512
Antwort-Kriterium-Paare pro Prüfung zulässig; umfangreiche Kriterienkataloge sollten auf mehrere
Quizze verteilt werden.

Das Makro zeigt keine zusätzliche LLM-Ergebnisbox an. Lernende sehen ausschließlich LiaScripts
native Richtig/Falsch-Rückmeldung und – abhängig von `data-solution-button` – die normale
Auflösung. Kriterien, Evidenzpassagen und NLI-Einzelwerte bleiben im Auswertungsergebnis
`result.criteria` erhalten, etwa für spätere Kalibrierung oder ein vorbereitetes Fine-Tuning.
Bei direkter JavaScript-API-Nutzung kann eine Diagnose weiterhin bewusst mit
`formatResult(result, locale, {showCriteria:true})` erzeugt werden.
