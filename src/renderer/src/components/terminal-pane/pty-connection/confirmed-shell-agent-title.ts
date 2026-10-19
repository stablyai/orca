import { useAppStore } from '@/store'
import { titleAfterConfirmedShell } from '../../../../../shared/terminal-pane-title-reset'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: a plain `codex`/`grok` sets its OSC title and the shell never repaints
// it on exit, so a confirmed return-to-shell must clear a title that still
// names an agent — otherwise the tab reads "grok" over a bare prompt. Only
// reset an agent-named title; user/shell-set titles are left untouched.
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
