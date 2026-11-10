import type { AiVaultAgent, AiVaultSessionTitleKind } from './ai-vault-types'
import type { ExecutionHostId } from '../../execution-host'

export const AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT = 64

export type AiVaultSessionTitle = {
  agent: Extract<AiVaultAgent, 'claude' | 'codex'>
  sessionId: string
  title: string
  /** Absent from older hosts and saved tabs: unclassified, ranked like a fallback. */
  kind?: AiVaultSessionTitleKind
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

export function isAiVaultTitleAgent(
  agent: string | null | undefined
): agent is AiVaultSessionTitle['agent'] {
  return agent === 'claude' || agent === 'codex'
}

/** Kind is compared too, so a title whose text is unchanged can still become a known name. */
export function sameAiVaultSessionTitle(
  a: AiVaultSessionTitle | null | undefined,
  b: AiVaultSessionTitle | null | undefined
): boolean {
  return (
    a?.agent === b?.agent &&
    a?.sessionId === b?.sessionId &&
    a?.title === b?.title &&
    a?.kind === b?.kind
  )
}
