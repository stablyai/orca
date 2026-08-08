import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { useAppStore } from '@/store'
import { prefetchLayoutBaseCharacters } from '@/lib/keyboard-layout/layout-base-character'
import { createTerminalNativeOnlyShortcutTracker } from '@/components/terminal-pane/terminal-native-only-shortcut'
import { installTerminalNativeInputListeners } from '@/components/terminal-pane/terminal-native-input-listeners'
import {
  resolvePreviewShortcutAction,
  type PreviewShortcutContext
} from './preview-terminal-shortcuts'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { shouldBypassXtermForMacNativeText } from '@/components/terminal-pane/xterm-bypass-policy'
import { isLatinShortcutKey } from '@/lib/ime-latin-shortcut-key'

/**
 * Installs the preview terminal's ONE custom key handler (xterm allows a single
 * attachCustomKeyEventHandler) covering copy/paste chords and the full pane
 * shortcut policy. Plain Mod+V is left to the
 * Edit-menu accelerator, which reaches this window as ui:appMenuPaste — matching
 * it here too would paste twice.
 *
 * Returns a disposer for the Option-key location listeners the policy needs to
 * tell left Option from right.
 */
export function installPreviewTerminalKeyHandler(args: {
  terminal: Terminal
  pasteClipboardText: (activeElement: Element | null, source: 'keyboard') => void
  sendInput: (data: string) => void
  /** Everything but optionKeyLocation, which this installer tracks itself. */
  getShortcutContext: () => Omit<PreviewShortcutContext, 'optionKeyLocation'>
}): () => void {
  const { terminal } = args
  const platform = getShortcutPlatform()
  const consumedClipboardKeys = new Set<string>()
  const nativeOnlyShortcutTracker = createTerminalNativeOnlyShortcutTracker()
  const consumeEvent = (event: KeyboardEvent): false => {
    event.preventDefault()
    event.stopPropagation()
    return false
  }

  let optionKeyLocation = 0
  const disposeNativeInputListeners = installTerminalNativeInputListeners(
    window,
    nativeOnlyShortcutTracker,
    (location) => {
      optionKeyLocation = location
    },
    // Why: the preview dialog has dropped the tracked side on blur since #11015.
    { forgetOptionKeyLocationOnBlur: true }
  )
  if (platform === 'darwin') {
    // Why: kitty Option-chord encoding resolves base keys through the async
    // KeyboardLayoutMap; prefetch so the map is cached before the first chord.
    prefetchLayoutBaseCharacters()
  }

  terminal.attachCustomKeyEventHandler((event) => {
    if (isImeOwnedKeyboardEvent(event)) {
      return true
    }
    if (
      shouldBypassXtermForMacNativeText(
        event,
        platform === 'darwin',
        args.getShortcutContext().kittyKeyboardActive()
      )
    ) {
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
    nativeOnlyShortcutTracker.prepareKeyDown(event)
    const keybindings = useAppStore.getState().keybindings
    if (keybindingMatchesAction('terminal.copySelection', event, platform, keybindings)) {
      const keyIdentity = event.code || event.key
      const firstKeydown = !consumedClipboardKeys.has(keyIdentity)
      consumedClipboardKeys.add(keyIdentity)
      const selection = terminal.getSelection()
      if (firstKeydown && selection) {
        void window.api.ui.writeTerminalClipboardText(selection).catch(() => undefined)
      }
      return consumeEvent(event)
    }
    const isMenuPasteChord =
      (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      isLatinShortcutKey(event, 'v')
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

    const action = resolvePreviewShortcutAction(event, {
      ...args.getShortcutContext(),
      optionKeyLocation
    })
    if (!action) {
      return true
    }
    switch (action.type) {
      case 'sendInput':
        args.sendInput(action.data)
        return consumeEvent(event)
      case 'scrollViewport':
        if (action.position === 'top') {
          terminal.scrollToTop()
        } else {
          terminal.scrollToBottom()
        }
        return consumeEvent(event)
      case 'switchInputSource':
        // Why: the OS owns this chord — block xterm without preventing the default.
        nativeOnlyShortcutTracker.armKeyDown(event)
        event.stopImmediatePropagation()
        return false
      // Why: pane-scoped chords have no target in a preview dialog. Swallow them
      // — a pane never sends these bytes to the shell, and xterm would encode
      // e.g. Ctrl+Shift+D as a bare Ctrl+D. Listed one by one rather than under a
      // `default` so a newly added action has to be classified here, not
      // silently swallowed.
      case 'clearActivePane':
      case 'clearPaneTitle':
      case 'closeActivePane':
      case 'copySelection':
      case 'equalizePaneSizes':
      case 'focusPane':
      case 'setTitle':
      case 'splitActivePane':
      case 'toggleExpandActivePane':
      case 'toggleSearch':
        return consumeEvent(event)
    }
  })

  return disposeNativeInputListeners
}
