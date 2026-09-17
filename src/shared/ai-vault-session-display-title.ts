import type { AiVaultSession } from './ai-vault-types'

/** Agent + provider-session identity. NUL cannot appear in either side. */
export function aiVaultProviderSessionKey(agent: string, sessionId: string): string {
  return `${agent}\u0000${sessionId}`
}

/**
 * Session-list identity: an Orca tab rename wins over the scanner title
 * (harness custom title → AI title → first prompt → model/time fallback).
 * Subagent rows keep the scanner title so they cannot inherit a parent rename.
 */
export function resolveAiVaultSessionDisplayTitle(
  session: Pick<AiVaultSession, 'title' | 'subagent'>,
  customTitle: string | null | undefined
): string {
  if (session.subagent) {
    return session.title
  }
  return customTitle?.trim() || session.title
}
