import { mayDestroyWithoutOwnerEvidence } from '../../../../shared/pty-listed-session'
import type { UnifiedSessionRow } from './resource-usage-merge-types'

/** Skip confirmation only for unbound sessions with proven agent-owner absence; bound or unverifiable sessions must ask. */
export function requiresKillConfirmation(session: UnifiedSessionRow): boolean {
  return session.bound || !mayDestroyWithoutOwnerEvidence(session)
}
