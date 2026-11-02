import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'
import { translate } from '@/i18n/i18n'

let hasShownOsc52ClipboardBlockedToast = false
let hasShownOsc52ClipboardFailedToast = false

export function showOsc52ClipboardBlockedToast(): void {
  if (hasShownOsc52ClipboardBlockedToast) {
    return
  }

  toast.info(
    translate(
      'auto.components.terminal.pane.osc52.clipboard.blocked.toast.89eaa3e80b',
      'Terminal clipboard write blocked'
    ),
    {
      description: translate(
        'auto.components.terminal.pane.osc52.clipboard.blocked.toast.7cf51f74fd',
        'Enable TUI clipboard writes in Terminal settings to copy from SSH, Zellij, tmux, Neovim, fzf, or Grok.'
      ),
      duration: 12_000,
      action: {
        label: translate(
          'auto.components.terminal.pane.osc52.clipboard.blocked.toast.97c98f1afe',
          'Open Setting'
        ),
        onClick: () => {
          const store = useAppStore.getState()
          // Open the exact setting named by the remote-copy failure.
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
  // Latch after successful display so a throw cannot spend the session’s only notice.
  hasShownOsc52ClipboardBlockedToast = true
}

export function showOsc52ClipboardFailedToast(): void {
  if (hasShownOsc52ClipboardFailedToast) {
    return
  }

  toast.error(
    translate(
      'auto.components.terminal.pane.osc52.clipboard.failed.toast.62a0af2cb4',
      'Terminal clipboard copy could not be confirmed'
    ),
    {
      description: translate(
        'auto.components.terminal.pane.osc52.clipboard.failed.toast.fdd3e7e977',
        'The terminal app requested a copy, but Orca could not confirm that it reached the system clipboard.'
      ),
      duration: 12_000
    }
  )
  // Latch only after successful display, as for blocked writes.
  hasShownOsc52ClipboardFailedToast = true
}

const OSC52_CLIPBOARD_COPY_RETRY_TOAST_ID = 'osc52-clipboard-copy-retry'

/** Browsers refuse clipboard writes without a recent gesture; the Copy click supplies one. Not latched: each refusal replaces the last. */
export function showOsc52ClipboardCopyRetryToast(
  text: string,
  writeClipboardText: (text: string) => Promise<void>
): void {
  toast.error(
    translate(
      'auto.components.terminal.pane.osc52.clipboard.failed.toast.de286dcfe1',
      'Terminal copy needs a click'
    ),
    {
      id: OSC52_CLIPBOARD_COPY_RETRY_TOAST_ID,
      description: translate(
        'auto.components.terminal.pane.osc52.clipboard.failed.toast.84c938ffa2',
        'The browser blocked a copy from the terminal app. Click Copy to put the text on your clipboard.'
      ),
      duration: 30_000,
      action: {
        label: translate(
          'auto.components.terminal.pane.osc52.clipboard.failed.toast.a73165c6c5',
          'Copy'
        ),
        onClick: () => {
          void writeClipboardText(text).catch(showOsc52ClipboardFailedToast)
        }
      }
    }
  )
}
