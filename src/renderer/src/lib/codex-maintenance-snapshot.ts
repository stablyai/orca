import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'

export type CodexMaintenanceEntry = {
  state: CodexMaintenanceState | null
  logJob: CodexMaintenanceState['job']
  expiresAt: number
  starting: boolean
  error: string | null
  verification: 'checking' | 'current' | 'unverifiable'
}
export const EMPTY: CodexMaintenanceEntry = {
  state: null,
  logJob: null,
  expiresAt: 0,
  starting: false,
  error: null,
  verification: 'unverifiable'
}

export function codexMaintenanceEvidenceExpiry(
  evidence: CodexMaintenanceState['evidence'],
  requestedAt: number
): number {
  if (evidence?.observedAt === undefined) {
    return evidence?.expiresAt ?? 0
  }
  const now = Date.now()
  // Deduct the full round trip so a remote clock cannot extend the host's evidence.
  return now + Math.max(0, evidence.expiresAt - evidence.observedAt - (now - requestedAt))
}
