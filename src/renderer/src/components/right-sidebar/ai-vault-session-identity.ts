import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { areValuesEqual } from '@/store/slices/repo-identity-reconcile'
import { reuseEqualCatalogRows } from '@/store/slices/worktree-catalog-reconciliation'

// One instance is shared by every mounted hook, so it is frozen: an in-place
// sort or push by any consumer would otherwise leak into every other panel.
export const EMPTY_AI_VAULT_SESSIONS: readonly AiVaultSession[] = Object.freeze([])

// Why: listSessions always structured-clones nested session rows (previewMessages,
// subagent). A TTL miss remints scannedAt even when the disk contents did not
// change, and all-host merge used to remint it even on cache-hit legs. The panel
// only skipped apply when scannedAt matched, so alt-tab after 15s rebuilt
// sessionProjectById + the worktree path map for every row. Reuse previous row
// and result identity when the payload is structurally unchanged so those memos
// stay cold. Reference compare is inert here — IPC clones never match.
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
  const issues = areValuesEqual(current.issues, incoming.issues) ? current.issues : incoming.issues
  if (
    sessions === current.sessions &&
    issues === current.issues &&
    current.cancelled === incoming.cancelled
  ) {
    return current
  }
  if (sessions === incoming.sessions && issues === incoming.issues) {
    return incoming
  }
  return { ...incoming, sessions, issues }
}

export function applyPublishedAiVaultList(
  published: AiVaultListResult,
  setScanResult: (updater: (prev: AiVaultListResult | null) => AiVaultListResult) => void
): void {
  setScanResult((prev) => reuseAiVaultListResult(prev, published))
}
