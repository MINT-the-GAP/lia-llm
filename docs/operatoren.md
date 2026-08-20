---
schema: lia-llm-operator-profiles/v2
language: de
status: aktiv
---

# Operator- und Feedbackmatrix

Diese Datei beschreibt, welche Leistung ein Aufgabenoperator verlangt und welche kurze
Rückmeldung dazu passt. Sie ist die fachliche Spezifikation und Testmatrix. Die zur Laufzeit
verwendeten, typisierten Antwortverträge stehen in `src/operator-rubrics.ts`; diese Markdown-Datei
wird nicht ungeprüft im Browser geparst.

Die ausführlichen, fachspezifischen Definitionen für Mathematik und Physik stehen in
[`Operatoren.md`](../Operatoren.md). Sie bleiben die fachliche Ausgangsbasis; diese Matrix
übersetzt daraus nur diejenigen textuell prüfbaren Profile, die implementiert und durch
Verhaltens- oder Integrationsprüfungen abgesichert sind.

Eine Tabellenzeile ist eine semantische Anforderung, kein Satz der Musterlösung. Synonyme und
Paraphrasen in einer Lernendenantwort gehören ebenfalls nicht in die Operator-Aliasse: Sie werden
im Gesamtzusammenhang von den Bewertungsmodellen erkannt.

## Operatoren

| operator_id | Status | Bezeichnung | sichere Aufgabenformen | Aliasse | Ziel der Antwort | Beleg im lokalen Korpus |
| --- | --- | --- | --- | --- | --- | --- |
| `erklaeren` | aktiv | erklären | Erkläre; Erklären Sie | erklären; erkläre; erklaere | einen fachlichen Zusammenhang nachvollziehbar machen und Ursache, Prinzip oder Bedingung mit der Wirkung verknüpfen | `Operatoren.md: Mathematik und Physik`; `Wochenaufgabe/Alt/ProbeLKPhysik10_Wellen.md:1488–1503`, Revision `0a0dc2a1917be672b4cd3afb4aefffa7b136c869` |
| `erlaeutern` | aktiv | erläutern | Erläutere; Erläutern Sie | erläutern; erläutere; erlaeutere | einen Sachverhalt durch zusätzliche Informationen, ein Beispiel, eine Veranschaulichung oder Zwischenschritte verständlich machen | `Operatoren.md: Mathematik und Physik` |
| `beschreiben` | aktiv | beschreiben | Beschreibe; Beschreiben Sie | beschreibe | Merkmale, Zustände oder einen Ablauf sachlogisch, räumlich oder zeitlich geordnet wiedergeben | `Aufgabensammlung/02_Geometrie/07_Kongruenz/Aufgabe_0021.md:41–51`, Revision `484c7736abc42042d942061e446e3b98d8fb0443` |
| `begruenden` | aktiv | begründen | Begründe; Begründen Sie | begründen; begründe; begruende | eine Aussage oder Entscheidung durch passende fachliche Gründe oder Belege stützen | `Wochenaufgabe/Alt/Probeklausur12_1Mathematik_Stochastik.md:548–558`, Revision `0a0dc2a1917be672b4cd3afb4aefffa7b136c869` |
| `vergleichen` | aktiv | vergleichen | Vergleiche; Vergleichen Sie | vergleiche | beide Gegenstände anhand gemeinsamer Merkmale direkt gegenüberstellen | `Operatoren.md: Physik`; gezielte Positiv- und Gegenbeispiele ersetzen derzeit einen belastbaren Korpusfall |
| `beurteilen` | aktiv | beurteilen | Beurteile; Beurteilen Sie | beurteile | anhand fachlicher Kriterien und Belege zu einem begründeten Sachurteil kommen | `Aufgabensammlung/06_Stochastik/04_Binomialverteilung/Aufgabe_9999.md:1088–1103, 1215–1242`, Revision `484c7736abc42042d942061e446e3b98d8fb0443` |

`erlaeutern` bleibt bewusst ein eigenes Profil und ist kein Alias von `erklaeren`:
Eine Erläuterung verlangt eine verständlich machende Ergänzung, aber nicht zwingend die
Kausalrückführung einer Erklärung.

## Operatorspezifische Bewertungskriterien

| operator_id | criterion_id | semantische Anforderung | erforderlich_wenn | Priorität | feedback_code | sichtbare Rückmeldung |
| --- | --- | --- | --- | ---: | --- | --- |
| `erklaeren` | `explanatory-link` | Die Antwort verknüpft Ursache, Prinzip oder Bedingung nachvollziehbar mit der Wirkung oder dem Ergebnis; die Richtung des Zusammenhangs stimmt. | immer | 85 | `operator-not-met` | Stelle Ursache, Prinzip oder Bedingung und die daraus folgende Wirkung nachvollziehbar in Beziehung. |
| `erklaeren` | `beyond-assertion` | Die Antwort geht über das bloße Nennen oder Behaupten des Ergebnisses hinaus. | immer | 75 | `operator-not-met` | Ergänze, warum der genannte Sachverhalt oder das Ergebnis zustande kommt. |
| `erlaeutern` | `core-and-context` | Die Antwort stellt den Sachverhalt oder das Vorgehen korrekt dar und ergänzt relevante Informationen, Beispiele oder Zwischenschritte. | immer | 80 | `operator-not-met` | Ergänze die Darstellung um relevante Informationen, ein Beispiel oder nachvollziehbare Zwischenschritte. |
| `erlaeutern` | `illustrative-link` | Die Ergänzungen sind erkennbar mit dem Kern verbunden und machen ihn nachvollziehbar oder anschaulich. | immer | 75 | `operator-not-met` | Zeige deutlicher, wie deine Ergänzung den Sachverhalt oder das Vorgehen verständlich macht. |
| `beschreiben` | `relevant-features` | Die Antwort enthält die für die Aufgabe relevanten Merkmale, Zustände oder Schritte. | immer | 80 | `operator-not-met` | Ergänze die für die Aufgabe wesentlichen Merkmale, Zustände oder Schritte. |
| `beschreiben` | `ordered-presentation` | Die Merkmale oder Schritte werden sachlogisch, räumlich oder zeitlich geordnet und fachlich präzise dargestellt. | immer | 75 | `operator-not-met` | Ordne die Merkmale oder Schritte nachvollziehbar und formuliere sie fachlich präzise. |
| `begruenden` | `reason-or-evidence` | Die Antwort stützt die Aussage oder Entscheidung mit einem fachlich passenden Grund oder Beleg. | immer | 85 | `operator-not-met` | Nenne einen fachlich passenden Grund oder Beleg für deine Aussage oder Entscheidung. |
| `begruenden` | `reasoning-link` | Die logische Verbindung zwischen Aussage oder Entscheidung und dem angeführten Grund oder Beleg ist nachvollziehbar. | immer | 80 | `operator-not-met` | Verknüpfe deine Aussage nachvollziehbar mit dem angeführten Grund oder Beleg. |
| `vergleichen` | `comparison-dimensions` | Die Antwort verwendet gemeinsame, für die Aufgabe relevante Merkmale oder Kriterien für beide Vergleichsgegenstände. | immer | 80 | `operator-not-met` | Vergleiche beide Gegenstände anhand derselben relevanten Merkmale oder Kriterien. |
| `vergleichen` | `direct-contrast` | Die Antwort stellt beide Gegenstände direkt gegenüber und nennt die von der Aufgabe geforderten Gemeinsamkeiten und Unterschiede. | immer | 80 | `operator-not-met` | Stelle beide Gegenstände direkt gegenüber und benenne die geforderten Gemeinsamkeiten und Unterschiede. |
| `beurteilen` | `criteria-and-evidence` | Die Antwort zieht erkennbare fachliche Kriterien und relevante Belege für die Beurteilung heran. | immer | 85 | `operator-not-met` | Lege fachliche Kriterien und passende Belege für deine Beurteilung offen. |
| `beurteilen` | `reasoned-judgement` | Die Antwort entwickelt aus den Kriterien ein eindeutiges, nachvollziehbar begründetes Sachurteil und berücksichtigt die von der Aufgabe verlangte Abwägung. | immer | 85 | `operator-not-met` | Formuliere ein eindeutiges Sachurteil und leite es nachvollziehbar aus deinen Kriterien und Belegen ab. |

## Profilweite Rückmeldungen

Der profilweite Operatorhinweis ist der Kompatibilitäts-Fallback für ältere oder extern erzeugte
Ergebnisse ohne Kriteriums-ID. Neue Modellantworten mit unbekannter oder fehlender ID werden
verworfen und einmal neu angefordert. Die dritte Spalte gilt nur für den deterministischen Guard
extrem kurzer Eingaben.

| operator_id | Fallback für `operator-not-met` | Antwort deutlich zu kurz |
| --- | --- | --- |
| `erklaeren` | Die Antwort stellt den gefragten Erklärungszusammenhang noch nicht nachvollziehbar her. | Die Antwort ist deutlich zu kurz, um etwas zu erklären. |
| `erlaeutern` | Ergänze die Darstellung so, dass der Sachverhalt oder das Vorgehen nachvollziehbar und anschaulich wird. | Die Antwort ist deutlich zu kurz, um etwas zu erläutern. |
| `beschreiben` | Beschreibe die relevanten Merkmale oder Schritte vollständig, geordnet und fachlich präzise. | Die Antwort ist deutlich zu kurz, um den gefragten Sachverhalt zu beschreiben. |
| `begruenden` | Verknüpfe deine Aussage mit einem passenden fachlichen Grund oder Beleg. | Die Antwort ist deutlich zu kurz, um die Aussage zu begründen. |
| `vergleichen` | Stelle beide Gegenstände anhand gemeinsamer Kriterien direkt gegenüber und nenne die gefragten Gemeinsamkeiten und Unterschiede. | Die Antwort ist deutlich zu kurz, um die Gegenstände zu vergleichen. |
| `beurteilen` | Formuliere ein Sachurteil und begründe es anhand fachlicher Kriterien und relevanter Belege. | Die Antwort ist deutlich zu kurz, um ein begründetes Sachurteil zu entwickeln. |

Für `operator-check-unavailable` lautet die sichtbare Rückmeldung bei eingeschaltetem
Feedback: „Die verlangte Antwortform konnte gerade nicht zuverlässig geprüft werden. Versuche die
Prüfung erneut, sobald die Qualitätsprüfung verfügbar ist.“

## Allgemeine Kriterien

| criterion_id | semantische Anforderung | Priorität | feedback_code | Wirkung auf richtig/falsch | sichtbare Rückmeldung |
| --- | --- | ---: | --- | --- | --- |
| `factual_correctness` | Keine fachliche Falschaussage, Verneinung oder Umkehrung einer zentralen Aussage. | 100 | `content-error` | blockierend | Die Antwort enthält inhaltliche Fehler. |
| `task_relevance` | Die Antwort bezieht sich auf die gestellte Aufgabe und die Musterlösung. | 90 | `off-topic` | blockierend | Die Antwort geht noch nicht auf die gestellte Frage ein. |
| `sufficient_information` | Genügend relevante Informationseinheiten sind vorhanden; die Bewertung beruht nicht allein auf einer Wortzahl. | 80 | `answer-too-short` | blockierend | Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten. |
| `operator_fulfilment` | Die verlangte Antwortform des ausdrücklich gesetzten Operators ist erfüllt. | 70 | `operator-not-met` | blockierend | Die Antwort erfüllt die Anforderungen des Aufgabenoperators noch nicht. |
| `task_coverage` | Die gefragten Inhalte werden hinreichend vollständig abgedeckt. | 60 | `incomplete` | blockierend | Die Antwort bearbeitet die gefragten Inhalte noch nicht vollständig. |
| `clarity` | Die Aussagen ergeben im Gesamtzusammenhang eine eindeutige, schlüssige Antwort. | 50 | `unclear` | blockierend | Die Antwort ist noch nicht eindeutig genug. Formuliere den Zusammenhang klarer. |
| `appropriate_register` | Die Antwort ist überwiegend sachlich und hinreichend präzise; einfache Sprache oder einzelne umgangssprachliche Wörter reichen nicht für diesen Befund. | 20 | `too-colloquial` | nur Hinweis | Die Antwort ist zu umgangssprachlich verfasst. |

Die Zahlen in dieser allgemeinen Tabelle dokumentieren die fachliche Rangfolge. Die Laufzeit
bildet dieselbe Reihenfolge direkt ab, ohne diese Zahlen als konfigurierbare Scores zu verwenden.

## Auswertungsregeln

- Fachliche Entscheidung und diagnostische Rückmeldung bleiben getrennt.
- Bei mehreren Befunden wird höchstens die Rückmeldung mit der höchsten Priorität angezeigt.
- `too-colloquial` ist ein Stilhinweis und macht eine fachlich richtige Antwort nicht automatisch falsch.
- `answer-too-short` soll fehlende relevante Informationseinheiten beschreiben. Eine kleine
  Zeichengrenze darf nur offensichtlich leere oder extrem kurze Eingaben vorab abfangen.
- Operatorspezifische Rückmeldungen werden nur verwendet, wenn der Operator im Makro ausdrücklich
  gesetzt wurde.
- Der echte Aufgabenwortlaut wird zusammen mit dem expliziten Operator ausgewertet. Aus dem
  Operatorverb allein werden weder Gegenstand und Umfang der Aufgabe noch Zahlen, Kriterien oder
  eine Perspektive erfunden.
- Im dokumentierten Operator-Makropfad prüft das Kompaktmodell den Fachinhalt vor, entscheidet aber
  nicht endgültig über die Operatorerfüllung. Ein inhaltlicher Kompakt-Pass wird dort durch das
  Qualitätsmodell überprüft. Nur ein direkter API-Aufruf mit ausdrücklich gesetztem
  `assessmentEngine: "compact"` bleibt vollständig bei Compact und stuft einen solchen Befund
  konservativ zu `uncertain` herab.
- Meldet das Qualitätsmodell `operator-not-met`, ist der Befund unabhängig von einer
  anteiligen Bestehensgrenze blockierend.
- Zu `operator-not-met` muss das Modell eine Kriteriums-ID aus dem aktiven Profil
  zurückgeben. Die Laufzeit validiert diese ID und zeigt bei mehreren Befunden den
  kriterienspezifischen Hinweis mit der höchsten Priorität.
- Ist die Qualitätsprüfung nicht verfügbar, wird ein sonst bestandener Kompaktbefund nicht
  freigegeben. Der technische Befund `operator-check-unavailable` unterscheidet diesen
  Fall ausdrücklich von einem nachweislich nicht erfüllten Operator. Ein bereits vom
  Kompaktmodell erkannter Inhaltsfehler oder unzureichender Inhalt bleibt der vorrangige Befund.
- Operatoren werden nicht pauschal einem Anforderungsbereich zugeordnet. Eine solche Zuordnung
  hängt von Aufgabe, Fach, Jahrgang und erwarteter Bearbeitungstiefe ab.

## Laufzeit und Grenzen

Autoren setzen genau ein Profil explizit über `operator=...` und übergeben den
Aufgabenwortlaut mit `@LLMQuiz.question(...)`. Eine automatische Erkennung aus dem
Aufgabentext findet nicht statt. Die Legacy-Form `@LLMQuiz(...)` bleibt für Aufgaben ohne
Operator verfügbar.

Die sechs aktiven Profile prüfen textuelle Antwortprodukte. Rein grafische Leistungen wie
`zeichnen`, `skizzieren` oder `grafisch_darstellen` werden ohne
multimodale Artefaktprüfung nicht als Freitextoperatoren angeboten. Mehrere kumulative Operatoren
in einer Aufgabe sind ebenfalls noch nicht Teil des Makrovertrags.

## Modellkalibrierung

`npm run test:browser-operators` führt für jedes aktive Profil einen Positiv- und einen
gezielten Gegenfall mit dem WebGPU-Qualitätsmodell aus. Der Lauf prüft zusätzlich kanonische
Operator-ID, Quality-Engine und den erwarteten Fehlercode der Gegenfälle. Wegen des derzeit etwa
984 MB großen Quality-Modell-Downloads und der WebGPU-Abhängigkeit gehört diese Kalibrierung
bewusst nicht zum hardwareunabhängigen `npm run check`. In einem vollständig neuen Profil beträgt
die konfigurierte Schätzung für Quality- und Kompaktmodell zusammen 1.362.614.439 B
(ca. 1.299,5 MiB). Compact bleibt der sichere Standard; Qwen3-1.7B ist eine optionale
Quality-Engine und benötigt eine eigene Freigabe für das konkrete Browser-/GPU-System.

## Neue Operatoren ergänzen

Für einen neuen Operator werden mindestens benötigt:

1. eine stabile `operator_id` und eindeutig belegte Aufgabenformen,
2. ein typisierter Antwortvertrag mit Produkt, Ordnung, Beleg- und Verfahrenspflicht sowie
   ausdrücklich nicht ableitbaren Einschränkungen,
3. mehrere echte Aufgaben samt Musterlösungen,
4. positive Antworten, Grenzfälle und klare Gegenbeispiele,
5. semantische Kriterien statt einzelner Schlüsselwörter,
6. sichtbare Kurztexte und stabile Kriteriums-IDs,
7. Unit- und Browser-Tests, bevor das Profil in `src/operator-rubrics.ts` aktiviert wird.
