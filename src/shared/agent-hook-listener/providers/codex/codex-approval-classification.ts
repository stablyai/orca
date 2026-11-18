import type { HookListenerState } from '../../listener-state'
import {
  codexApprovalToolKey,
  codexTurnReviewer,
  requestCodexRolloutReviewer,
  type CodexApprovalHold
} from './codex-rollout-state'
import { normalizedTranscriptPath } from './codex-rollout-paths'
import { getOrCreateCodexRolloutState } from './codex-state'

/** Codex PermissionRequest precedes reviewer/user decisions; suppress reviewer-owned waiting (STA-7698). request_user_input still blocks a human on PreToolUse (#9861). */
export function resolveCodexApprovalOwnedState(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  transcriptPath: string | undefined,
  stateName: 'working' | 'waiting' | 'done',
  hookPayload: Record<string, unknown>
): { state: 'working' | 'waiting' | 'done'; hold?: CodexApprovalHold } {
  const filePath = normalizedTranscriptPath(transcriptPath)
  if (stateName !== 'waiting' || eventName !== 'PermissionRequest' || !filePath) {
    return { state: stateName }
  }
  const rollout = getOrCreateCodexRolloutState(state, paneKey)
  const known = codexTurnReviewer(rollout, filePath)
  const shown = known === undefined || known === 'auto_review' ? 'working' : 'waiting'
  // Ordering rule: until this turn's reviewer is read, waiting is held for a read that starts after
  // this request, so an approval Codex's own reviewer resolves never flashes Needs you; a known
  // reviewer classifies at once and the same read rechecks it.
  const seq = requestCodexRolloutReviewer(rollout, filePath)
  return {
    state: shown,
    hold: { filePath, seq, heldAt: Date.now(), toolKey: codexApprovalToolKey(hookPayload), shown }
  }
}
