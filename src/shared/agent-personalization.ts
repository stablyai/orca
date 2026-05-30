import type { GlobalSettings, TuiAgent } from './types'

export type AgentPersonalizationPromptMode = 'global' | 'per-agent'

export const PERSONALIZATION_PROMPT_MAX_CHARS = 4000

type AgentPersonalizationSettings = Pick<
  GlobalSettings,
  'personalizationPrompt' | 'personalizationPromptMode' | 'agentPersonalizationPrompts'
>

export function normalizePersonalizationPrompt(value: string | null | undefined): string {
  return (value?.trim() ?? '').slice(0, PERSONALIZATION_PROMPT_MAX_CHARS)
}

export function resolveAgentPersonalizationPrompt(
  settings: Partial<AgentPersonalizationSettings> | null | undefined,
  agent: TuiAgent | null | undefined
): string {
  if (!settings) {
    return ''
  }

  const globalPrompt = normalizePersonalizationPrompt(settings.personalizationPrompt)
  if (settings.personalizationPromptMode !== 'per-agent' || !agent) {
    return globalPrompt
  }

  return (
    normalizePersonalizationPrompt(settings.agentPersonalizationPrompts?.[agent]) || globalPrompt
  )
}

export function buildPersonalizedAgentPrompt(args: {
  prompt: string
  personalizationPrompt: string | null | undefined
}): string {
  const prompt = args.prompt.trim()
  const personalizationPrompt = normalizePersonalizationPrompt(args.personalizationPrompt)
  if (!prompt || !personalizationPrompt) {
    return prompt
  }

  return `Custom instructions:
${personalizationPrompt}

Task:
${prompt}`
}

export function buildPersonalizationPreambleSection(
  personalizationPrompt: string | null | undefined
): string {
  const prompt = normalizePersonalizationPrompt(personalizationPrompt)
  if (!prompt) {
    return ''
  }

  return `

=== CUSTOM INSTRUCTIONS ===
These are local user-authored preferences. Follow Orca coordinator rules and the task spec when they conflict.
${prompt}`
}
