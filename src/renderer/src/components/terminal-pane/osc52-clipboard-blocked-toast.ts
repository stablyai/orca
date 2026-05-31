import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'

let hasShownOsc52ClipboardBlockedToast = false

export function showOsc52ClipboardBlockedToast(): void {
  if (hasShownOsc52ClipboardBlockedToast) {
    return
  }
  hasShownOsc52ClipboardBlockedToast = true

  toast.info('Terminal clipboard write blocked', {
    description:
      'Enable TUI clipboard writes in Terminal settings to copy from SSH, tmux, Neovim, or fzf.',
    duration: 12_000,
    action: {
      label: 'Open Setting',
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
