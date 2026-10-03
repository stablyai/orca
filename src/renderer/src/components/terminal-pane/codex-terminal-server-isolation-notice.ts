import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { isCodexTerminalServerIsolationEnabled } from '../../../../shared/codex-terminal-server-isolation'

type CodexNoticeState = Pick<
  AppState,
  | 'persistedUIReady'
  | 'codexTerminalServerIsolationNoticeSeen'
  | 'settings'
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'paneForegroundAgentByPaneKey'
>

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and a typed `codex` seen locally.
function hasCodexTerminal(state: CodexNoticeState): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === 'codex')
    ) ||
    Object.values(state.agentStatusByPaneKey).some((entry) => entry.agentType === 'codex') ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === 'codex')
  )
}

export function shouldShowCodexTerminalServerIsolationNotice(state: CodexNoticeState): boolean {
  return (
    state.persistedUIReady &&
    !state.codexTerminalServerIsolationNoticeSeen &&
    state.settings !== null &&
    // Why: a user who already opted out needs no announcement of the default.
    isCodexTerminalServerIsolationEnabled(state.settings) &&
    hasCodexTerminal(state)
  )
}

function didNoticeInputsChange(state: CodexNoticeState, previous: CodexNoticeState): boolean {
  return (
    state.persistedUIReady !== previous.persistedUIReady ||
    state.settings !== previous.settings ||
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

const NOTICE_TOAST_ID = 'codex-terminal-server-isolation-notice'

/** For a pane whose Codex shares the server anyway: its banner says so, and this toast would contradict it. */
export function retireCodexTerminalServerIsolationNotice(): void {
  useAppStore.getState().markCodexTerminalServerIsolationNoticeSeen()
  toast.dismiss(NOTICE_TOAST_ID)
}

function showCodexTerminalServerIsolationNotice(): void {
  // Why mark before showing: seen means shown, so a quit or reload never repeats it.
  useAppStore.getState().markCodexTerminalServerIsolationNoticeSeen()
  toast.info(
    translate(
      'terminal.codexTerminalServerIsolationNotice.title',
      'Orca now runs Codex without its shared server'
    ),
    {
      // Why a stable id: a late sync that resets the flag can't stack a second toast.
      id: NOTICE_TOAST_ID,
      description: translate(
        'terminal.codexTerminalServerIsolationNotice.description',
        'This makes agent status more reliable. You can turn it back on in Settings.'
      ),
      duration: Infinity,
      action: {
        label: translate(
          'terminal.codexTerminalServerIsolationNotice.openSettings',
          'Open Settings'
        ),
        onClick: () => {
          const store = useAppStore.getState()
          store.openSettingsPage()
          store.openSettingsTarget({
            pane: 'agents',
            repoId: null,
            sectionId: CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID
          })
        }
      }
    }
  )
}

export function useCodexTerminalServerIsolationNotice(): void {
  const seen = useAppStore((s) => s.codexTerminalServerIsolationNoticeSeen)

  useEffect(() => {
    // Why: a paired web client's terminals follow the host's setting, not this window's.
    if (seen || isPairedWebClientWindow()) {
      return
    }
    if (shouldShowCodexTerminalServerIsolationNotice(useAppStore.getState())) {
      showCodexTerminalServerIsolationNotice()
      return
    }
    // Why a filtered subscription: a selector would rescan every tab on each store write.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        didNoticeInputsChange(state, previous) &&
        shouldShowCodexTerminalServerIsolationNotice(state)
      ) {
        unsubscribe()
        showCodexTerminalServerIsolationNotice()
      }
    })
    return unsubscribe
  }, [seen])
}
