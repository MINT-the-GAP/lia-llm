---
schema: lia-llm-operator-profiles/v1
language: de
status: Entwurf
---

# Operator- und Feedbackmatrix

Diese Datei beschreibt, welche Leistung ein Aufgabenoperator verlangt und welche kurze
Rückmeldung dazu passt. Sie ist die fachliche Spezifikation und Testmatrix. Die zur Laufzeit
verwendeten, typisierten Profile stehen in `src/operator-rubrics.ts`; diese Markdown-Datei wird
nicht ungeprüft im Browser geparst.

Die ausführlichen, fachspezifischen Definitionen für Mathematik und Physik stehen in
[`Operatoren.md`](../Operatoren.md). Sie bleiben die fachliche Ausgangsbasis; diese Matrix
übersetzt daraus nur diejenigen Profile, die bereits implementiert und mit Antwortbeispielen
getestet sind.

Eine Tabellenzeile ist eine semantische Anforderung, kein Satz der Musterlösung. Synonyme und
Paraphrasen in einer Lernendenantwort gehören ebenfalls nicht in die Operator-Aliasse: Sie werden
im Gesamtzusammenhang von den Bewertungsmodellen erkannt.

## Operatoren

| operator_id | Status | Bezeichnung | sichere Aufgabenformen | Alias-Kandidaten, noch zu prüfen | Ziel der Antwort | Beleg im lokalen Korpus |
| --- | --- | --- | --- | --- | --- | --- |
| `erklaeren` | aktiv | erklären | Erkläre; Erklären Sie | – | einen fachlichen Zusammenhang nachvollziehbar machen und auf Regeln oder Gesetzmäßigkeiten zurückführen | `Operatoren.md: Physik`; `MINT-the-GAP/Wochenaufgabe: ProbeLKPhysik10_Wellen.md:1469`, Revision `2c7d1e3ae13a5e4523dfc67f31ba8684175e5d1a` |
| `erlaeutern` | geplant | erläutern | Erläutere; Erläutern Sie | – | einen Sachverhalt veranschaulichen und durch zusätzliche Informationen beziehungsweise ein nachvollziehbares Vorgehen verständlich machen | `Operatoren.md: Mathematik und Physik` |
| `beschreiben` | geplant | beschreiben | Beschreibe; Beschreiben Sie | – | Merkmale, Zustände oder einen Ablauf sachlogisch geordnet wiedergeben | `MINT-the-GAP/Wochenaufgabe: Probeklausur11_2Physik.md:132`, gleiche Revision |
| `begruenden` | geplant | begründen | Begründe; Begründen Sie | – | eine Aussage oder Entscheidung durch passende Gründe oder Belege stützen | `MINT-the-GAP/Wochenaufgabe: ProbeLKPhysik11_Mechanik.md:127`, gleiche Revision |
| `vergleichen` | geplant | vergleichen | Vergleiche; Vergleichen Sie | – | Gemeinsamkeiten und Unterschiede anhand passender Merkmale gegenüberstellen | noch mit realen Aufgaben und Gegenbeispielen zu belegen |
| `beurteilen` | geplant | beurteilen | Beurteile; Beurteilen Sie | – | anhand erkennbarer Kriterien zu einem begründeten Urteil kommen | `MINT-the-GAP/Aufgabensammlung: Aufgabe_9999.md:1095`, Revision `8fba682ee3ea70dcf0d1b700ca423812e7d18ea2` |

`erlaeutern` wird bewusst nicht als Alias von `erklaeren` behandelt. Die fachspezifische
Ausgangstabelle verlangt dafür eine eigene Leistung; das Profil wird erst aktiviert, wenn reale
Aufgaben, Musterlösungen und Grenzfälle dafür als Tests vorliegen.

## Operatorspezifische Bewertungskriterien

| operator_id | criterion_id | semantische Anforderung | erforderlich_wenn | Priorität | feedback_code | sichtbare Rückmeldung |
| --- | --- | --- | --- | ---: | --- | --- |
| `erklaeren` | `relevant_content` | Die für die Frage wesentlichen fachlichen Aussagen sind enthalten. | immer | 80 | `incomplete` | Die Antwort erklärt den gefragten Zusammenhang noch nicht vollständig. |
| `erklaeren` | `explanatory_link` | Ursache, Prinzip oder Bedingung werden nachvollziehbar mit der Wirkung verknüpft; die Kausalrichtung ist nicht vertauscht. | immer | 85 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Erklärung. |
| `erklaeren` | `beyond_assertion` | Die Antwort geht über ein bloßes Nennen oder Behaupten des Ergebnisses hinaus. | wenn die Aufgabe eine Erklärung verlangt | 75 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Erklärung. |
| `erlaeutern` | `illustration_and_context` | Der Sachverhalt wird veranschaulicht und durch zusätzliche relevante Informationen oder ein nachvollziehbares Vorgehen verständlich gemacht. | geplant | 80 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Erläuterung. |
| `beschreiben` | `ordered_features` | Relevante Merkmale oder Schritte werden sachlogisch, räumlich oder zeitlich geordnet dargestellt. | geplant | 75 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Beschreibung. |
| `begruenden` | `reasoning_link` | Aussage oder Entscheidung, passender Grund beziehungsweise Beleg und ihre Verbindung sind erkennbar. | geplant | 85 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Begründung. |
| `vergleichen` | `comparison_dimensions` | Mindestens eine relevante Gemeinsamkeit oder ein Unterschied wird anhand eines gemeinsamen Merkmals gegenübergestellt. | geplant | 75 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien eines Vergleichs. |
| `beurteilen` | `criteria_based_judgement` | Ein Urteil wird anhand erkennbarer Kriterien und relevanter Belege entwickelt; nötige Abwägungen werden berücksichtigt. | geplant | 85 | `operator-not-met` | Die Antwort entspricht noch nicht den Kriterien einer Beurteilung. |

## Allgemeine Kriterien

| criterion_id | semantische Anforderung | Priorität | feedback_code | Wirkung auf richtig/falsch | sichtbare Rückmeldung |
| --- | --- | ---: | --- | --- | --- |
| `factual_correctness` | Keine fachliche Falschaussage, Verneinung oder Umkehrung einer zentralen Aussage. | 100 | `content-error` | blockierend | Die Antwort enthält inhaltliche Fehler. |
| `task_relevance` | Die Antwort bezieht sich auf die gestellte Aufgabe und die Musterlösung. | 90 | `off-topic` | blockierend | Die Antwort geht noch nicht auf die gestellte Frage ein. |
| `sufficient_information` | Genügend relevante Informationseinheiten sind vorhanden; die Bewertung beruht nicht allein auf einer Wortzahl. | 80 | `answer-too-short` | blockierend | Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten. |
| `operator_fulfilment` | Die verlangte Antwortform des ausdrücklich gesetzten Operators ist erfüllt. | 70 | `operator-not-met` | blockierend | Die Antwort erfüllt die Anforderungen des Aufgabenoperators noch nicht. |
| `task_coverage` | Der gefragte Zusammenhang wird hinreichend vollständig abgedeckt. | 60 | `incomplete` | blockierend | Die Antwort erklärt den gefragten Zusammenhang noch nicht vollständig. |
| `clarity` | Die Aussagen ergeben im Gesamtzusammenhang eine eindeutige, schlüssige Antwort. | 50 | `unclear` | blockierend | Die Antwort ist noch nicht eindeutig genug. Formuliere den Zusammenhang klarer. |
| `appropriate_register` | Die Antwort ist überwiegend sachlich und hinreichend präzise; einfache Sprache oder einzelne umgangssprachliche Wörter reichen nicht für diesen Befund. | 20 | `too-colloquial` | nur Hinweis | Die Antwort ist zu umgangssprachlich verfasst. |

## Auswertungsregeln

- Fachliche Entscheidung und diagnostische Rückmeldung bleiben getrennt.
- Bei mehreren Befunden wird höchstens die Rückmeldung mit der höchsten Priorität angezeigt.
- `too-colloquial` ist ein Stilhinweis und macht eine fachlich richtige Antwort nicht automatisch falsch.
- `answer-too-short` soll fehlende relevante Informationseinheiten beschreiben. Eine kleine
  Zeichengrenze darf nur offensichtlich leere oder extrem kurze Eingaben vorab abfangen.
- Operatorspezifische Rückmeldungen werden nur verwendet, wenn der Operator im Makro ausdrücklich
  gesetzt wurde.
- Operatoren werden nicht pauschal einem Anforderungsbereich zugeordnet. Eine solche Zuordnung
  hängt von Aufgabe, Fach, Jahrgang und erwarteter Bearbeitungstiefe ab.

## Neue Operatoren ergänzen

Für einen neuen Operator werden mindestens benötigt:

1. eine stabile `operator_id` und eindeutig belegte Aufgabenformen,
2. mehrere echte Aufgaben samt Musterlösungen,
3. positive Antworten, Grenzfälle und klare Gegenbeispiele,
4. semantische Anforderungen statt einzelner Schlüsselwörter,
5. ein sichtbarer Kurztext und ein stabiler `feedback_code`,
6. Unit- und Browser-Tests, bevor das Profil in `src/operator-rubrics.ts` aktiviert wird.
