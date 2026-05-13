import type { GlobalSettings, TuiAgent } from './types'

export type AgentPersonalizationPromptMode = 'global' | 'per-agent'

type AgentPersonalizationSettings = Pick<
  GlobalSettings,
  'personalizationPrompt' | 'personalizationPromptMode' | 'agentPersonalizationPrompts'
>

export function normalizePersonalizationPrompt(value: string | null | undefined): string {
  return value?.trim() ?? ''
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
${prompt}`
}
