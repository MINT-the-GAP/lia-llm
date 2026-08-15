import type { OperatorRubric } from "./types.ts"

type OperatorDefinition = Omit<OperatorRubric, "requirements">

function defineRubric(definition: OperatorDefinition): OperatorRubric {
  return {
    ...definition,
    requirements: definition.criteria.map((criterion) => criterion.requirement),
  }
}

const RUBRICS: readonly OperatorRubric[] = [
  defineRubric({
    id: "erklaeren",
    label: "Erklärung",
    aliases: ["erklaeren", "erklären", "erklaere", "erkläre"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "nachvollziehbare fachliche Erklärung",
      organization: [
        "Ursache, Prinzip oder Bedingung benennen",
        "mit der daraus folgenden Wirkung oder dem Ergebnis verknüpfen",
      ],
      evidencePolicy: "task-dependent",
      procedurePolicy: "task-dependent",
      constraints: [
        "Die konkrete Erklärungstiefe folgt aus der Aufgabe und der Musterlösung.",
        "Eine bloße Nennung oder Behauptung genügt nicht.",
      ],
    },
    criteria: [
      {
        id: "explanatory-link",
        label: "Erklärungszusammenhang",
        requirement:
          "Die Antwort verknüpft Ursache, Prinzip oder Bedingung nachvollziehbar mit der Wirkung oder dem Ergebnis; die Richtung des Zusammenhangs stimmt.",
        priority: 85,
        required: true,
        feedback: {
          de: "Stelle Ursache, Prinzip oder Bedingung und die daraus folgende Wirkung nachvollziehbar in Beziehung.",
          en: "Connect the cause, principle, or condition clearly to the resulting effect.",
        },
      },
      {
        id: "beyond-assertion",
        label: "Mehr als eine Behauptung",
        requirement:
          "Die Antwort geht über das bloße Nennen oder Behaupten des Ergebnisses hinaus.",
        priority: 75,
        required: true,
        feedback: {
          de: "Ergänze, warum der genannte Sachverhalt oder das Ergebnis zustande kommt.",
          en: "Add why the stated fact or result occurs.",
        },
      },
    ],
    operatorFeedback: {
      de: "Die Antwort stellt den gefragten Erklärungszusammenhang noch nicht nachvollziehbar her.",
      en: "The answer does not yet establish the requested explanatory relationship.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um etwas zu erklären.",
      en: "The answer is much too short to provide an explanation.",
    },
  }),
  defineRubric({
    id: "erlaeutern",
    label: "Erläuterung",
    aliases: ["erlaeutern", "erläutern", "erlaeutere", "erläutere"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "veranschaulichende und ergänzende Erläuterung",
      organization: [
        "Sachverhalt oder Vorgehen darstellen",
        "durch relevante Zusatzinformationen, Beispiele oder Zwischenschritte verständlich machen",
      ],
      evidencePolicy: "task-dependent",
      procedurePolicy: "task-dependent",
      constraints: [
        "Erläutern ist nicht mit Erklären gleichzusetzen.",
        "Die Aufgabe bestimmt, ob ein Beispiel, eine Darstellung oder ein Vorgehen erwartet wird.",
      ],
    },
    criteria: [
      {
        id: "core-and-context",
        label: "Kern und Zusatzinformation",
        requirement:
          "Die Antwort stellt den Sachverhalt oder das Vorgehen korrekt dar und ergänzt relevante Informationen, Beispiele oder Zwischenschritte.",
        priority: 80,
        required: true,
        feedback: {
          de: "Ergänze die Darstellung um relevante Informationen, ein Beispiel oder nachvollziehbare Zwischenschritte.",
          en: "Add relevant information, an example, or traceable intermediate steps.",
        },
      },
      {
        id: "illustrative-link",
        label: "Nachvollziehbare Veranschaulichung",
        requirement:
          "Die Ergänzungen sind erkennbar mit dem Kern verbunden und machen ihn nachvollziehbar oder anschaulich.",
        priority: 75,
        required: true,
        feedback: {
          de: "Zeige deutlicher, wie deine Ergänzung den Sachverhalt oder das Vorgehen verständlich macht.",
          en: "Show more clearly how the added detail makes the subject or procedure understandable.",
        },
      },
    ],
    operatorFeedback: {
      de: "Ergänze die Darstellung so, dass der Sachverhalt oder das Vorgehen nachvollziehbar und anschaulich wird.",
      en: "Expand the response so that the subject or procedure becomes clear and illustrative.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um etwas zu erläutern.",
      en: "The answer is much too short to elaborate on the subject.",
    },
  }),
  defineRubric({
    id: "beschreiben",
    label: "Beschreibung",
    aliases: ["beschreiben", "beschreibe"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "geordnete fachliche Beschreibung",
      organization: [
        "relevante Merkmale, Zustände oder Schritte auswählen",
        "sachlogisch, räumlich oder zeitlich geordnet wiedergeben",
      ],
      evidencePolicy: "not-required",
      procedurePolicy: "task-dependent",
      constraints: [
        "Eine Begründung oder kausale Herleitung ist nicht automatisch erforderlich.",
        "Fachsprache und Genauigkeit richten sich nach Fach, Aufgabe und Lerngruppe.",
      ],
    },
    criteria: [
      {
        id: "relevant-features",
        label: "Relevante Merkmale oder Schritte",
        requirement:
          "Die Antwort enthält die für die Aufgabe relevanten Merkmale, Zustände oder Schritte.",
        priority: 80,
        required: true,
        feedback: {
          de: "Ergänze die für die Aufgabe wesentlichen Merkmale, Zustände oder Schritte.",
          en: "Add the features, states, or steps that are essential for the task.",
        },
      },
      {
        id: "ordered-presentation",
        label: "Geordnete Darstellung",
        requirement:
          "Die Merkmale oder Schritte werden sachlogisch, räumlich oder zeitlich geordnet und fachlich präzise dargestellt.",
        priority: 75,
        required: true,
        feedback: {
          de: "Ordne die Merkmale oder Schritte nachvollziehbar und formuliere sie fachlich präzise.",
          en: "Order the features or steps clearly and state them with subject-specific precision.",
        },
      },
    ],
    operatorFeedback: {
      de: "Beschreibe die relevanten Merkmale oder Schritte vollständig, geordnet und fachlich präzise.",
      en: "Describe the relevant features or steps completely, in order, and with subject-specific precision.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um den gefragten Sachverhalt zu beschreiben.",
      en: "The answer is much too short to describe the requested subject.",
    },
  }),
  defineRubric({
    id: "begruenden",
    label: "Begründung",
    aliases: ["begruenden", "begründen", "begruende", "begründe"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "fachlich begründete Aussage oder Entscheidung",
      organization: [
        "zu begründende Aussage oder Entscheidung kenntlich machen",
        "passenden Grund oder Beleg logisch damit verbinden",
      ],
      evidencePolicy: "required",
      procedurePolicy: "task-dependent",
      constraints: [
        "Die Art des Belegs oder Vorgehens kann durch die Aufgabe festgelegt sein.",
        "Ein Grund ohne erkennbare Verbindung zur Aussage genügt nicht.",
      ],
    },
    criteria: [
      {
        id: "reason-or-evidence",
        label: "Passender Grund oder Beleg",
        requirement:
          "Die Antwort stützt die Aussage oder Entscheidung mit einem fachlich passenden Grund oder Beleg.",
        priority: 85,
        required: true,
        feedback: {
          de: "Nenne einen fachlich passenden Grund oder Beleg für deine Aussage oder Entscheidung.",
          en: "Give a relevant subject-specific reason or piece of evidence for the statement or decision.",
        },
      },
      {
        id: "reasoning-link",
        label: "Logische Begründungsverbindung",
        requirement:
          "Die logische Verbindung zwischen Aussage oder Entscheidung und dem angeführten Grund oder Beleg ist nachvollziehbar.",
        priority: 80,
        required: true,
        feedback: {
          de: "Verknüpfe deine Aussage nachvollziehbar mit dem angeführten Grund oder Beleg.",
          en: "Connect the statement clearly to the reason or evidence provided.",
        },
      },
    ],
    operatorFeedback: {
      de: "Verknüpfe deine Aussage mit einem passenden fachlichen Grund oder Beleg.",
      en: "Connect the statement to a relevant subject-specific reason or piece of evidence.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um die Aussage zu begründen.",
      en: "The answer is much too short to justify the statement.",
    },
  }),
  defineRubric({
    id: "vergleichen",
    label: "Vergleich",
    aliases: ["vergleichen", "vergleiche"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "kriteriengeleiteter Vergleich",
      organization: [
        "gemeinsame relevante Vergleichsmerkmale festlegen",
        "beide Gegenstände je Merkmal direkt gegenüberstellen",
      ],
      evidencePolicy: "task-dependent",
      procedurePolicy: "not-required",
      constraints: [
        "Geforderte Gemeinsamkeiten und Unterschiede müssen erkennbar sein.",
        "Verlangt die Aufgabe ausdrücklich nur Gemeinsamkeiten oder nur Unterschiede, gilt diese Einschränkung.",
        "Zwei unverbundene Einzelbeschreibungen bilden noch keinen Vergleich.",
      ],
    },
    criteria: [
      {
        id: "comparison-dimensions",
        label: "Gemeinsame Vergleichsmerkmale",
        requirement:
          "Die Antwort verwendet gemeinsame, für die Aufgabe relevante Merkmale oder Kriterien für beide Vergleichsgegenstände.",
        priority: 80,
        required: true,
        feedback: {
          de: "Vergleiche beide Gegenstände anhand derselben relevanten Merkmale oder Kriterien.",
          en: "Compare both subjects using the same relevant features or criteria.",
        },
      },
      {
        id: "direct-contrast",
        label: "Direkte Gegenüberstellung",
        requirement:
          "Die Antwort stellt beide Gegenstände direkt gegenüber und nennt die von der Aufgabe geforderten Gemeinsamkeiten und Unterschiede.",
        priority: 80,
        required: true,
        feedback: {
          de: "Stelle beide Gegenstände direkt gegenüber und benenne die geforderten Gemeinsamkeiten und Unterschiede.",
          en: "Contrast both subjects directly and state the requested similarities and differences.",
        },
      },
    ],
    operatorFeedback: {
      de: "Stelle beide Gegenstände anhand gemeinsamer Kriterien direkt gegenüber und nenne die gefragten Gemeinsamkeiten und Unterschiede.",
      en: "Contrast both subjects directly using common criteria and state the requested similarities and differences.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um die Gegenstände zu vergleichen.",
      en: "The answer is much too short to compare the subjects.",
    },
  }),
  defineRubric({
    id: "beurteilen",
    label: "Beurteilung",
    aliases: ["beurteilen", "beurteile"],
    minAnswerCharacters: 12,
    responseContract: {
      product: "kriteriengestütztes und begründetes Sachurteil",
      organization: [
        "fachliche Kriterien und relevante Belege heranziehen",
        "daraus ein nachvollziehbares Sachurteil entwickeln",
      ],
      evidencePolicy: "required",
      procedurePolicy: "not-required",
      constraints: [
        "Perspektive, Kriterien und Umfang folgen aus der konkreten Aufgabe.",
        "Nötige Gegenargumente oder Abwägungen sind zu berücksichtigen.",
        "Gesellschaftliche Werte und Normen kennzeichnen den eigenständigen Operator Bewerten.",
      ],
    },
    criteria: [
      {
        id: "criteria-and-evidence",
        label: "Fachliche Kriterien und Belege",
        requirement:
          "Die Antwort zieht erkennbare fachliche Kriterien und relevante Belege für die Beurteilung heran.",
        priority: 85,
        required: true,
        feedback: {
          de: "Lege fachliche Kriterien und passende Belege für deine Beurteilung offen.",
          en: "State the subject-specific criteria and relevant evidence used for the judgement.",
        },
      },
      {
        id: "reasoned-judgement",
        label: "Begründetes Sachurteil",
        requirement:
          "Die Antwort entwickelt aus den Kriterien ein eindeutiges, nachvollziehbar begründetes Sachurteil und berücksichtigt die von der Aufgabe verlangte Abwägung.",
        priority: 85,
        required: true,
        feedback: {
          de: "Formuliere ein eindeutiges Sachurteil und leite es nachvollziehbar aus deinen Kriterien und Belegen ab.",
          en: "State a clear judgement and derive it transparently from the criteria and evidence.",
        },
      },
    ],
    operatorFeedback: {
      de: "Formuliere ein Sachurteil und begründe es anhand fachlicher Kriterien und relevanter Belege.",
      en: "State a judgement and justify it using subject-specific criteria and relevant evidence.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um ein begründetes Sachurteil zu entwickeln.",
      en: "The answer is much too short to develop a reasoned judgement.",
    },
  }),
]

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE").replace(/\s+/gu, " ")
}

const RUBRIC_BY_ALIAS = new Map<string, OperatorRubric>()
for (const rubric of RUBRICS) {
  RUBRIC_BY_ALIAS.set(normalizeAlias(rubric.id), rubric)
  for (const alias of rubric.aliases) {
    RUBRIC_BY_ALIAS.set(normalizeAlias(alias), rubric)
  }
}

export function resolveOperatorRubric(
  value: string | null | undefined,
): OperatorRubric | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined
  }
  const rubric = RUBRIC_BY_ALIAS.get(normalizeAlias(value))
  if (rubric) return rubric

  throw new Error(
    `Der Aufgabenoperator "${value}" wird noch nicht unterstützt. Unterstützt: ${RUBRICS.map((entry) => entry.id).join(", ")}.`,
  )
}

export function supportedOperatorRubrics(): readonly OperatorRubric[] {
  return RUBRICS
}
