import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'
import { translate } from '@/i18n/i18n'

let hasShownOsc52ClipboardBlockedToast = false

export function showOsc52ClipboardBlockedToast(): void {
  if (hasShownOsc52ClipboardBlockedToast) {
    return
  }
  hasShownOsc52ClipboardBlockedToast = true

  toast.info(translate("auto.components.terminal.pane.osc52.clipboard.blocked.toast.89eaa3e80b", "Terminal clipboard write blocked"), {
    description:
      translate("auto.components.terminal.pane.osc52.clipboard.blocked.toast.7cf51f74fd", "Enable TUI clipboard writes in Terminal settings to copy from SSH, tmux, Neovim, or fzf."),
    duration: 12_000,
    action: {
      label: translate("auto.components.terminal.pane.osc52.clipboard.blocked.toast.97c98f1afe", "Open Setting"),
      onClick: () => {
        const store = useAppStore.getState()
        // Why: open the exact row instead of a generic Terminal page so the
        // remote-copy failure points to the setting named by the shell message.
        store.setSettingsSearchQuery('')
        store.openSettingsTarget({
          pane: 'terminal',
          repoId: null,
          sectionId: OSC52_CLIPBOARD_SETTING_ID
        })
        store.openSettingsPage()
      }
    }
  })
}
