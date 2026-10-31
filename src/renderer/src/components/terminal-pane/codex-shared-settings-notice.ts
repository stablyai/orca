import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

/** Whether to show the one-time "Codex now uses ~/.codex" card this session, and its dismiss. */
export function useCodexSharedSettingsNotice(): { visible: boolean; dismiss: () => void } {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.codexSharedSettingsNoticeSeen)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Why skip paired web clients: the change is on the host, whose own window shows this.
    if (seen || !isLocalWindowsDesktopClient()) {
      return
    }
    return whenCodexTerminalAppears(() => {
      // Why mark before showing: seen means shown, so a quit or reload never repeats it.
      useAppStore.getState().markCodexSharedSettingsNoticeSeen()
      setVisible(true)
    })
  }, [seen])

  const dismiss = useCallback(() => setVisible(false), [])
  return { visible, dismiss }
}
