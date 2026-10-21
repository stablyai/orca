import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { isCodexTerminalServerIsolationEnabled } from '../../../../shared/codex-terminal-server-isolation'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

// Why no hydration check: the seen flag defaults to true until the persisted value arrives.
function isNoticeDue(state: AppState): boolean {
  return (
    !state.codexTerminalServerIsolationNoticeSeen &&
    state.settings !== null &&
    // Why: a user who already opted out needs no announcement of the default.
    isCodexTerminalServerIsolationEnabled(state.settings)
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
  const due = useAppStore(isNoticeDue)

  useEffect(() => {
    // Why: a paired web client's terminals follow the host's setting, not this window's.
    if (!due || isPairedWebClientWindow()) {
      return
    }
    return whenCodexTerminalAppears(showCodexTerminalServerIsolationNotice)
  }, [due])
}
