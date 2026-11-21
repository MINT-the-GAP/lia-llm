type BrowserPromptMessage = { role: "system" | "user"; content: string }
type TextOptions = {
  expectedInputs: Array<{ type: "text"; languages: string[] }>
  expectedOutputs: Array<{ type: "text"; languages: string[] }>
}

interface BrowserLanguageModel {
  availability(options: TextOptions): Promise<string>
  create(options: TextOptions & {
    initialPrompts: BrowserPromptMessage[]
    signal: AbortSignal
  }): Promise<{
    prompt(input: string, options: {
      responseConstraint: object
      signal: AbortSignal
    }): Promise<string>
    destroy(): void
  }>
}

export type BrowserQualityPrompt = (
  messages: BrowserPromptMessage[],
  responseConstraint: object,
) => Promise<string>

const textOptions: TextOptions = {
  expectedInputs: [{ type: "text", languages: ["de", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
}

export function getBrowserLanguageModel(): BrowserLanguageModel | undefined {
  const api = (globalThis as { LanguageModel?: BrowserLanguageModel }).LanguageModel
  if (typeof api?.availability === "function" && typeof api.create === "function") return api
  return undefined
}

export async function readyBrowserQualityPrompt(
  api: BrowserLanguageModel,
  signal: AbortSignal,
): Promise<BrowserQualityPrompt | undefined> {
  if (await api.availability(textOptions) !== "available") return undefined
  signal.throwIfAborted()

  return async (messages, responseConstraint) => {
    signal.throwIfAborted()
    const session = await api.create({
      ...textOptions,
      initialPrompts: messages.filter((message) => message.role === "system"),
      signal,
    })
    try {
      signal.throwIfAborted()
      const userPrompt = messages.filter((message) => message.role === "user")
        .map((message) => message.content).join("\n\n")
      return await session.prompt(userPrompt, { signal, responseConstraint })
    } finally {
      session.destroy()
    }
  }
}
