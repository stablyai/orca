import type { AiVaultAgent } from './ai-vault-types'

export type AiVaultProjectSuggestionSource = {
  cwd: string
  agent: AiVaultAgent
}

export type AiVaultProjectSuggestion = {
  path: string
  name: string
  sessionCount: number
  agents: AiVaultAgent[]
}

export type AiVaultSuggestProjectsArgs = {
  sources: AiVaultProjectSuggestionSource[]
}
