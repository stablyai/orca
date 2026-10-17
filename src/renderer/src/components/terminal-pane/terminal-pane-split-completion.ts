import { trackTerminalPaneSplit } from '@/lib/feature-education-telemetry'
import { useAppStore } from '@/store'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import { equalizeTerminalPanes } from './terminal-pane-layout-owner-commands'

export type TerminalPaneSplitEqualizeTarget = Parameters<typeof equalizeTerminalPanes>[0]

export type TerminalPaneSplitCompletion = {
  source: TerminalPaneSplitSource
  direction: 'vertical' | 'horizontal'
  telemetrySuppressed?: boolean
  /** Only user and CLI splits pass one; restored or mirrored layouts keep their stored ratios. */
  equalizeTarget?: TerminalPaneSplitEqualizeTarget
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
  equalizePanesAfterSplit(completion.equalizeTarget)
  return true
}

/** Applies terminalEqualizePanesOnSplit at split time only, so later sash drags survive. */
function equalizePanesAfterSplit(target: TerminalPaneSplitEqualizeTarget | undefined): void {
  if (!target) {
    return
  }
  const state = useAppStore.getState()
  // Why: an expanded pane owns every flex value, so the manual equalize command bails the same way.
  if (!state.settings?.terminalEqualizePanesOnSplit || state.expandedPaneByTabId[target.tabId]) {
    return
  }
  equalizeTerminalPanes(target, () => {})
}
