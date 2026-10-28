import { useAppStore } from '@/store'
import { titleAfterConfirmedShell } from '../../../../../shared/terminal-pane-title-reset'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Clear only agent-named titles on confirmed shell return; plain codex/grok can leave OSC titles the shell never repaints.
export function clearStaleAgentTabTitleOnConfirmedShell(session: ConnectPanePtySession): void {
  const state = useAppStore.getState()
  const currentTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
  const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
    (entry) => entry.id === session.deps.tabId
  )
  const neutralTitle = titleAfterConfirmedShell(
    currentTitle ?? tab?.title,
    session.neutralTerminalTitle()
  )
  if (neutralTitle === null) {
    return
  }
  session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, neutralTitle)
  if (session.manager.getActivePane()?.id === session.pane.id) {
    session.deps.updateTabTitle(session.deps.tabId, neutralTitle)
  }
}
