import { pickSourceControlLaunchAgent } from '../../../../../../shared/source-control/ai/source-control-launch-agent-selection'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export function shouldRenderCommitArea(
  unresolvedConflictCount: number,
  conflictOperation: GitConflictOperation,
  sequencerRecoverySupported = true
): boolean {
  return (
    unresolvedConflictCount === 0 &&
    (conflictOperation === 'unknown' ||
      (conflictOperation === 'revert' && !sequencerRecoverySupported))
  )
}

export function pickDefaultSourceControlAgent(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedAgents: TuiAgent[],
  disabledAgents?: TuiAgent[]
): TuiAgent | null {
  return pickSourceControlLaunchAgent({
    defaultAgent,
    detectedAgents,
    disabledAgents
  })
}
