import { useEffect } from 'react'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '../../../../../shared/workspace-layout/terminal-pane-title-sanitization'
import type { TerminalPaneStartupController } from '../controller/use-terminal-pane-startup-actions'

export function useSyntheticPaneTitlePruning({
  managerRef,
  paneCount,
  paneTitles,
  paneTitlesRef,
  savedLayout,
  setPaneTitles,
  setTabLayout,
  tabId,
  terminalTab,
  persistLayoutSnapshot
}: Pick<
  TerminalPaneStartupController,
  | 'managerRef'
  | 'paneCount'
  | 'paneTitles'
  | 'paneTitlesRef'
  | 'savedLayout'
  | 'setPaneTitles'
  | 'setTabLayout'
  | 'tabId'
  | 'terminalTab'
> & { persistLayoutSnapshot: () => void }) {
  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((previous) => {
      if (!previous[paneId] || !isSyntheticSinglePaneTitle(previous[paneId], terminalTab)) {
        return previous
      }
      const next = { ...previous }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
  }, [
    paneCount,
    paneTitles,
    persistLayoutSnapshot,
    terminalTab,
    managerRef,
    paneTitlesRef,
    setPaneTitles
  ])
}
