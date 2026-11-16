import { useAppStore } from '@/store'
import { ptyHostAdvertisesCapability } from '@/runtime/hosts/capabilities/pty-host-capability'
import { AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import type { HostTurnEndFacts } from '../../../shared/agent-status/contracts/agent-status-types'

// Older paired hosts lack turn-end stamps.
function ptyHostStampsTurnEnds(ptyId: string | null | undefined): boolean {
  return ptyHostAdvertisesCapability(
    useAppStore.getState().runtimeStatusByEnvironmentId,
    ptyId,
    AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY
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
