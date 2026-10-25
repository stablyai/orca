import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

function showCodexSharedSettingsNotice(): void {
  // Why mark before showing: seen means shown, so a quit or reload never repeats it.
  useAppStore.getState().markCodexSharedSettingsNoticeSeen()
  toast.info(
    translate('terminal.codexSharedSettingsNotice.title', 'Codex in Orca now uses ~/.codex'),
    {
      // Why a stable id: a late sync that resets the flag can't stack a second toast.
      id: 'codex-shared-settings-notice',
      description: translate(
        'terminal.codexSharedSettingsNotice.description',
        'Codex may ask again to trust folders or approve commands. Re-add any MCP servers you added only in Orca.'
      ),
      // Why no timeout: it is marked seen before showing, so an auto-close would lose it for good.
      duration: Infinity
    }
  )
}

export function useCodexSharedSettingsNotice(): void {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.codexSharedSettingsNoticeSeen)

  useEffect(() => {
    // Why skip paired web clients: the change is on the host, whose own window shows this.
    if (seen || !isLocalWindowsDesktopClient()) {
      return
    }
    return whenCodexTerminalAppears(showCodexSharedSettingsNotice)
  }, [seen])
}
