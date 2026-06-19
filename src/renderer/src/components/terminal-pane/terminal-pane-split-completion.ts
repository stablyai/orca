import { trackTerminalPaneSplit } from '@/lib/feature-education-telemetry'
import { useAppStore } from '@/store'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'

export type TerminalPaneSplitCompletion = {
  source: TerminalPaneSplitSource
  direction: 'vertical' | 'horizontal'
  telemetrySuppressed?: boolean
}

export function recordCreatedTerminalPaneSplit(
  createdPane: unknown,
  completion: TerminalPaneSplitCompletion
): boolean {
  if (!createdPane) {
    return false
  }
  useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
  if (!completion.telemetrySuppressed) {
    trackTerminalPaneSplit({
      source: completion.source,
      direction: completion.direction
    })
  }
  return true
}
