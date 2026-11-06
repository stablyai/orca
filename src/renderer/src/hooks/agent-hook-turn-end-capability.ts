import { useAppStore } from '@/store'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import '../../../shared/protocol-version'
import { AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import type { HostTurnEndFacts } from '../../../shared/agent-status/contracts/agent-status-types'

// Older paired hosts lack turn-end stamps; local/WSL relay uses this build, while unbound PTYs remain unknown.
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

/** Gate pane turn-end behavior by bound-host evidence: identified gives hook authority, ambiguous retains title authority, and legacy/unbound preserves main behavior. */
export function hookTurnEndEvidence(
  ptyId: string | null | undefined,
  row: Pick<HostTurnEndFacts, 'turnEndDisposition'> | undefined
): HookTurnEndEvidence {
  const disposition = row?.turnEndDisposition
  return disposition && ptyHostStampsTurnEnds(ptyId) ? disposition : 'legacy'
}
