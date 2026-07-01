import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'

export function emptyLayoutSnapshot(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
}

export function singlePaneLayoutSnapshot(
  leafId: string,
  ptyId?: string,
  title?: string | null
): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {}),
    ...(title ? { titlesByLeafId: { [leafId]: title } } : {})
  }
}

export function clearTransientTerminalState(tab: TerminalTab, index: number): TerminalTab {
  const hasTransientAgentTitle = detectAgentStatusFromTitle(tab.title) !== null
  if (hasTransientAgentTitle) {
    return {
      ...tab,
      ptyId: null,
      title: getResetTitle(tab, index),
      // Why: the fallback is not an OSC 0/1 observation; keeping authority
      // would make "Terminal N" outrank generated or quick labels after restore.
      titleSource: undefined
    }
  }

  return {
    ...tab,
    ptyId: null,
    title: getResetTitle(tab, index)
  }
}

function getResetTitle(tab: TerminalTab, index: number): string {
  const fallbackTitle =
    tab.customTitle?.trim() || tab.defaultTitle?.trim() || `Terminal ${index + 1}`
  // Why: reset any recognized agent title on hydration. The prior-session
  // agent is no longer running after a restart, so showing a stale
  // "Claude done" or spinner would be misleading.
  return detectAgentStatusFromTitle(tab.title) ? fallbackTitle : tab.title
}
