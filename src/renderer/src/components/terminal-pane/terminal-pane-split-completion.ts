import { trackTerminalPaneSplit } from '@/lib/feature-education-telemetry'
import { useAppStore } from '@/store'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'

/** Minimal manager surface: split completion only ever equalizes. */
export type TerminalPaneSplitEqualizeTarget = {
  tabId: string
  manager: { equalizePaneSizes: () => void }
}

export type TerminalPaneSplitCompletion = {
  source: TerminalPaneSplitSource
  direction: 'vertical' | 'horizontal'
  telemetrySuppressed?: boolean
  /** Omitted by paths that rebuild a persisted layout, which must keep its stored ratios. */
  equalizeTarget?: TerminalPaneSplitEqualizeTarget
}

export function completeCreatedTerminalPaneSplit(
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
  if (!state.settings?.terminalEqualizePanesOnSplit) {
    return
  }
  // Why: an expanded pane owns every flex value; equalizing under it is invisible
  // and lost on collapse, so the manual equalize command bails the same way.
  if (state.expandedPaneByTabId[target.tabId]) {
    return
  }
  target.manager.equalizePaneSizes()
}
