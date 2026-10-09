import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

export const AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT = 64

export type AiVaultSessionTitle = {
  agent: Extract<AiVaultAgent, 'claude' | 'codex' | 'rovo'>
  sessionId: string
  title: string
}

export type AiVaultSessionTitleRequest = {
  agent: AiVaultSessionTitle['agent']
  sessionId: string
  transcriptPath?: string
}

export type AiVaultSessionTitlesArgs = {
  executionHostScope?: ExecutionHostId
  requests: AiVaultSessionTitleRequest[]
}

export type AiVaultSessionTitlesResult = {
  titles: AiVaultSessionTitle[]
}

/** Agents whose title is read by session id and rewritten when each turn ends. */
export function refreshesAiVaultTitleOnTurnEnd(agent: unknown): boolean {
  // Why: Rovo saves metadata.json (and its first title) at turn end; no transcript path to poll.
  return agent === 'rovo'
}

export function isAiVaultTitleAgent(agent: unknown): agent is AiVaultSessionTitle['agent'] {
  return agent === 'claude' || agent === 'codex' || agent === 'rovo'
}
