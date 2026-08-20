export const THINKING_TIME_CHOICES_SECONDS = [0, 5, 10, 15, 20, 30] as const

export const THINKING_TOKEN_PRESETS = {
  low: 256,
  medium: 512,
  high: 768,
  ultra: 1_024,
  extreme: 2_048,
} as const

export type ThinkingTokenPreset = keyof typeof THINKING_TOKEN_PRESETS

export const DEFAULT_MAX_THINKING_TIME_MS = 15_000
export const DEFAULT_MAX_THINKING_TOKENS = THINKING_TOKEN_PRESETS.medium
export const MAX_MAX_THINKING_TIME_MS = 30_000
export const MIN_MAX_THINKING_TOKENS = THINKING_TOKEN_PRESETS.low
export const MAX_MAX_THINKING_TOKENS = THINKING_TOKEN_PRESETS.extreme
export const LONG_ANSWER_THINKING_WORDS = 160

export interface ThinkingLimits {
  maxTimeMs: number
  maxTokens: number
}

function boundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`,
    )
  }
  return value
}

export function normalizeThinkingLimits(options?: {
  maxThinkingTimeMs?: number
  maxThinkingTokens?: number
}): ThinkingLimits {
  return {
    maxTimeMs: boundedInteger(
      'maxThinkingTimeMs',
      options?.maxThinkingTimeMs ?? DEFAULT_MAX_THINKING_TIME_MS,
      0,
      MAX_MAX_THINKING_TIME_MS,
    ),
    maxTokens: boundedInteger(
      'maxThinkingTokens',
      options?.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS,
      MIN_MAX_THINKING_TOKENS,
      MAX_MAX_THINKING_TOKENS,
    ),
  }
}

export function normalizeAdaptiveThinkingLimits(
  options: {
    maxThinkingTimeMs?: number
    maxThinkingTokens?: number
  } | undefined,
  wordCount: number,
): ThinkingLimits {
  const limits = normalizeThinkingLimits(options)
  if (wordCount < LONG_ANSWER_THINKING_WORDS) return limits
  return {
    maxTimeMs:
      options?.maxThinkingTimeMs ?? MAX_MAX_THINKING_TIME_MS,
    maxTokens:
      options?.maxThinkingTokens ?? THINKING_TOKEN_PRESETS.ultra,
  }
}
