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
  // Why gate on hydration: before ui.get() lands the flag reads false, and firing
  // on the default would nag every profile that was never opted out.
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
        // Why a stable id: StrictMode re-runs this effect against the same closure, so
        // the early return can't catch the second pass — sonner dedupes it instead.
        id: 'osc52-clipboard-default-on-notice',
        description: translate(
          'auto.components.terminal.pane.osc52.clipboard.default.on.notice.description',
          'Zellij, tmux, Neovim and other terminal programs can now copy to your clipboard. Turn it off in Terminal settings.'
        ),
        duration: 15_000,
        // Why consume on close rather than on enqueue: this is the profile's one notice that
        // a security posture changed under it, and the flag can never re-arm once the settings
        // stamp lands. Clearing at enqueue spends it on launches where nothing was ever seen —
        // a quit inside the 15s, a crash in the gap. Clearing on close costs at most a repeat
        // next launch, which the user ends by dismissing it.
        onAutoClose: clearNotice,
        onDismiss: clearNotice,
        action: {
          label: translate(
            'auto.components.terminal.pane.osc52.clipboard.default.on.notice.action',
            'Open Setting'
          ),
          onClick: () => {
            // Why clear here too: sonner's action path deletes the toast without firing
            // onDismiss, so acting on the notice would otherwise leave it armed.
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
