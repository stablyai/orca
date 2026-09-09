/**
 * Opening a terminal on the host that owns a document, with the install command typed but not run.
 *
 * This is the whole install mechanism, and it is deliberately not a background spawn:
 *
 *  - Orca's terminals already execute on the workspace's owning host, so a remote install needs no
 *    new code and no new authority.
 *  - Nothing runs without an explicit human keystroke, which is the difference between Orca
 *    suggesting an installer and Orca running one.
 *  - On Windows it keeps Orca from originating a `powershell.exe` invocation against a downloaded
 *    script — the pattern docs/reference/windows-edr-posture.md records as producing Defender
 *    incidents. The reader running it in their own shell is their choice to make.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Pastes the command into a fresh terminal without submitting it. */
export function openOfficeInstallTerminal(worktreeId: string, command: string): boolean {
  const state = useAppStore.getState()
  try {
    const tab = state.createTab(worktreeId, undefined, undefined, {
      pendingStartup: { command, delivery: 'terminal-paste' }
    })
    state.setActiveTabType('terminal')
    return Boolean(tab)
  } catch {
    toast.error(
      translate(
        'auto.lib.office.install.terminal.failed',
        'Orca could not open a terminal on that machine.'
      )
    )
    return false
  }
}
