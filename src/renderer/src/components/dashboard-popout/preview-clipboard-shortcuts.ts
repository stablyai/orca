import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { useAppStore } from '@/store'

/**
 * Installs the popout preview terminal's ONE custom key handler (xterm allows
 * a single attachCustomKeyEventHandler) covering copy/paste chords and the
 * IME native-text bypass. Plain Mod+V is left to the Edit-menu accelerator,
 * which reaches this window as ui:appMenuPaste — matching it here too would
 * paste twice.
 */
export function installPreviewClipboardShortcuts(args: {
  terminal: Terminal
  claimImeKeyEvent: (event: KeyboardEvent) => boolean
  pasteClipboardText: (activeElement: Element | null, source: 'keyboard') => void
}): void {
  const { terminal } = args
  const platform = getShortcutPlatform()
  const consumedClipboardKeys = new Set<string>()
  const consumeEvent = (event: KeyboardEvent): false => {
    event.preventDefault()
    event.stopPropagation()
    return false
  }
  terminal.attachCustomKeyEventHandler((event) => {
    if (args.claimImeKeyEvent(event)) {
      // Why: bypass xterm's kitty encoder for native-text keydowns so the committed glyph survives via the input event.
      return false
    }
    if (event.type !== 'keydown') {
      const keyIdentity = event.code || event.key
      if (consumedClipboardKeys.has(keyIdentity)) {
        if (event.type === 'keyup') {
          consumedClipboardKeys.delete(keyIdentity)
        }
        return consumeEvent(event)
      }
      return true
    }
    const keybindings = useAppStore.getState().keybindings
    if (keybindingMatchesAction('terminal.copySelection', event, platform, keybindings)) {
      const keyIdentity = event.code || event.key
      const firstKeydown = !consumedClipboardKeys.has(keyIdentity)
      consumedClipboardKeys.add(keyIdentity)
      const selection = terminal.getSelection()
      if (firstKeydown && selection) {
        void window.api.ui.writeClipboardText(selection).catch(() => undefined)
      }
      return consumeEvent(event)
    }
    const isMenuPasteChord =
      (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'v'
    if (
      !isMenuPasteChord &&
      keybindingMatchesAction('terminal.paste', event, platform, keybindings)
    ) {
      const keyIdentity = event.code || event.key
      if (!consumedClipboardKeys.has(keyIdentity)) {
        consumedClipboardKeys.add(keyIdentity)
        args.pasteClipboardText(document.activeElement, 'keyboard')
      }
      return consumeEvent(event)
    }
    return true
  })
}
