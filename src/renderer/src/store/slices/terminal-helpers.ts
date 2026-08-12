import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'

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
  const { titleHydrationPending: _titleHydrationPending, ...persistedTab } = tab
  void _titleHydrationPending
  const titleWasReset = classifyTitleActivity(tab.title) !== null
  const launchIdentityNeedsTitleReplay = titleWasReset && tab.launchAgent !== undefined
  return {
    ...persistedTab,
    ptyId: null,
    title: titleWasReset ? getFallbackTitle(tab, index) : tab.title,
    ...(launchIdentityNeedsTitleReplay ? { titleHydrationPending: true } : {})
  }
}

function getFallbackTitle(tab: TerminalTab, index: number): string {
  return tab.customTitle?.trim() || tab.defaultTitle?.trim() || `Terminal ${index + 1}`
}
