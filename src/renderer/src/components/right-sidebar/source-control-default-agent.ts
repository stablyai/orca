import { pickSourceControlLaunchAgent } from '@/lib/source-control-launch-agent-selection'
import type { TuiAgent } from '../../../../shared/types'

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
