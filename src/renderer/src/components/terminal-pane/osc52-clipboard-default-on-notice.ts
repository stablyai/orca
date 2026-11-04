import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'

/** Whether the migrating launch should tell the user their OSC 52 opt-out was overridden. */
export function shouldShowOsc52ClipboardDefaultOnNotice(input: {
  persistedUIReady: boolean
  noticePending: boolean
}): boolean {
  // Wait for hydration: the default false would notify profiles that never opted out.
  return input.persistedUIReady && input.noticePending
}

export function useOsc52ClipboardDefaultOnNotice(persistedUIReady: boolean): void {
  const noticePending = useAppStore((s) => s.osc52ClipboardDefaultOnNoticePending)
  const clearNotice = useAppStore((s) => s.clearOsc52ClipboardDefaultOnNotice)

  useEffect(() => {
    if (!shouldShowOsc52ClipboardDefaultOnNotice({ persistedUIReady, noticePending })) {
      return
    }
    toast.info(
      translate(
        'auto.components.terminal.pane.osc52.clipboard.default.on.notice.title',
        'TUI clipboard writes are now on by default'
      ),
      {
        // A stable ID lets sonner dedupe StrictMode’s repeat against the same closure.
        id: 'osc52-clipboard-default-on-notice',
        description: translate(
          'auto.components.terminal.pane.osc52.clipboard.default.on.notice.description',
          'Zellij, tmux, Neovim and other terminal programs can now copy to your clipboard. Turn it off in Terminal settings.'
        ),
        duration: 15_000,
        // Consume this one-time security-posture notice on close; enqueue could spend it on an unseen toast before a quit or crash.
        onAutoClose: clearNotice,
        onDismiss: clearNotice,
        action: {
          label: translate(
            'auto.components.terminal.pane.osc52.clipboard.default.on.notice.action',
            'Open Setting'
          ),
          onClick: () => {
            // Sonner actions omit onDismiss, so consume the notice here too.
            clearNotice()
            const store = useAppStore.getState()
            store.setSettingsSearchQuery('')
            store.openSettingsTarget({
              pane: 'terminal',
              repoId: null,
              sectionId: OSC52_CLIPBOARD_SETTING_ID
            })
            store.openSettingsPage()
          }
        }
      }
    )
  }, [clearNotice, noticePending, persistedUIReady])
}
