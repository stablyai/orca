import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { reuseEqualCatalogRows } from '@/store/slices/worktree-catalog-reconciliation'

// Freeze the shared sentinel so one consumer cannot mutate every panel's initial rows.
export const EMPTY_AI_VAULT_SESSIONS: readonly AiVaultSession[] = Object.freeze([])

// IPC clones defeat reference equality and scannedAt changes on TTL misses; reuse structural identity to preserve row memos.
export function reuseAiVaultListResult(
  current: AiVaultListResult | null,
  incoming: AiVaultListResult
): AiVaultListResult {
  if (current === incoming) {
    return current
  }
  if (!current) {
    return incoming
  }
  const sessions = reuseEqualCatalogRows(current.sessions, incoming.sessions)
  const issues = structuralValuesEqual(current.issues, incoming.issues)
    ? current.issues
    : incoming.issues
  if (
    sessions === current.sessions &&
    issues === current.issues &&
    current.cancelled === incoming.cancelled &&
    current.scanId === incoming.scanId
  ) {
    return current
  }
  if (sessions === incoming.sessions && issues === incoming.issues) {
    return incoming
  }
  return { ...incoming, sessions, issues }
}
