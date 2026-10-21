import { useAppStore } from '@/store'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../shared/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { HostTurnEndFacts } from '../../../shared/agent-status-types'

// Why: a paired server (incl. SSH) that predates the turn-end stamp can't tell a later turn end
// from a restatement. Local and WSL-relay PTYs always run this build; an unbound PTY is unknown.
function ptyHostStampsTurnEnds(ptyId: string | null | undefined): boolean {
  if (!ptyId) {
    return false
  }
  if (!isRemoteRuntimePtyId(ptyId)) {
    return true
  }
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  const entry = environmentId
    ? useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
    : undefined
  return (
    lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
      AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY
    ) === true
  )
}

export type HookTurnEndEvidence = 'identified' | 'ambiguous' | 'legacy'

/**
 * The one decision for every pane behavior hook-owned turn ends changed, the same for every agent:
 * the pane's bound PTY runs on a host that stamps turn ends, and how that host identified the
 * current end. `identified`: the hook lane owns it. `ambiguous`: main's title role stays. `legacy`
 * (old host, unbound PTY, no disposition): main's behavior exactly.
 */
export function hookTurnEndEvidence(
  ptyId: string | null | undefined,
  row: Pick<HostTurnEndFacts, 'turnEndDisposition'> | undefined
): HookTurnEndEvidence {
  const disposition = row?.turnEndDisposition
  return disposition && ptyHostStampsTurnEnds(ptyId) ? disposition : 'legacy'
}
