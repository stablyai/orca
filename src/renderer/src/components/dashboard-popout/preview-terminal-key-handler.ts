import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { useAppStore } from '@/store'
import {
  getLayoutCharacterForCode,
  prefetchLayoutCharacters
} from '@/lib/keyboard-layout/layout-base-character'
import { createTerminalNativeOnlyShortcutTracker } from '@/components/terminal-pane/terminal-native-only-shortcut'
import { createOptionKeyLocationTracker } from '@/lib/keyboard-layout/option-key-location-state'
import { createTerminalOptionKittyReleaseTracker } from '@/components/terminal-pane/terminal-option-kitty-release'
import {
  resolvePreviewShortcutAction,
  type PreviewShortcutContext
} from './preview-terminal-shortcuts'

/**
 * Installs the preview terminal's ONE custom key handler (xterm allows a single
 * attachCustomKeyEventHandler) covering copy/paste chords, the IME native-text
 * bypass, and the full pane shortcut policy. On macOS plain Cmd+V is left to
 * the Edit-menu accelerator, which reaches this window as an app-menu paste —
 * matching it here too would paste twice.
 *
 * Returns a disposer for the Option-key location listeners the policy needs to
 * tell left Option from right.
 */
export function installPreviewTerminalKeyHandler(args: {
  terminal: Terminal
  claimImeKeyEvent: (event: KeyboardEvent) => boolean
  pasteClipboardText: (activeElement: Element | null, source: 'keyboard') => void
  onClose?: () => void
  sendInput: (data: string) => void
  /** Everything but optionKeyLocations, which this installer tracks itself. */
  getShortcutContext: () => Omit<PreviewShortcutContext, 'optionKeyLocations'>
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

  // Why: a character key's KeyboardEvent.location reports its own position, so
  // left-vs-right Option must be recorded from the modifier's own keydown.
  const optionKeyLocations = createOptionKeyLocationTracker()
  const optionKittyReleases = createTerminalOptionKittyReleaseTracker()
  const onModifierDown = (event: KeyboardEvent): void => {
    optionKeyLocations.keyDown(event)
  }
  const onModifierUp = (event: KeyboardEvent): void => {
    optionKeyLocations.keyUp(event)
  }
  const onWindowBlur = (): void => {
    optionKeyLocations.clear()
    optionKittyReleases.clear()
    nativeOnlyShortcutTracker.clear()
  }
  const onNativeOnlyShortcutCompanion = (event: KeyboardEvent): void => {
    if (!nativeOnlyShortcutTracker.consumeCompanion(event)) {
      return
    }
    if (event.type === 'keypress') {
      event.preventDefault()
    }
    event.stopImmediatePropagation()
  }
  const onNativeOnlyBeforeInput = (event: Event): void => {
    if (
      !(event instanceof InputEvent) ||
      !nativeOnlyShortcutTracker.shouldSuppressBeforeInput(event)
    ) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  if (platform === 'darwin') {
    // Why: kitty Option-chord encoding resolves base keys through the async
    // KeyboardLayoutMap; prefetch so the map is cached before the first chord.
    prefetchLayoutCharacters()
  }
  window.addEventListener('keydown', onModifierDown, true)
  window.addEventListener('keyup', onModifierUp, true)
  window.addEventListener('keypress', onNativeOnlyShortcutCompanion, true)
  window.addEventListener('keyup', onNativeOnlyShortcutCompanion, true)
  window.addEventListener('beforeinput', onNativeOnlyBeforeInput, true)
  window.addEventListener('blur', onWindowBlur)

  terminal.attachCustomKeyEventHandler((event) => {
    if (args.claimImeKeyEvent(event)) {
      // Why: bypass xterm's kitty encoder for native-text keydowns so the committed glyph survives via the input event.
      return false
    }
    if (event.type !== 'keydown') {
      if (event.type === 'keyup' && optionKittyReleases.settle(event)) {
        return consumeEvent(event)
      }
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
      const selection = terminal.getSelection()
      if (
        !selection &&
        platform !== 'darwin' &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        return true
      }
      const keyIdentity = event.code || event.key
      const firstKeydown = !consumedClipboardKeys.has(keyIdentity)
      consumedClipboardKeys.add(keyIdentity)
      if (firstKeydown && selection) {
        void window.api.ui.writeTerminalClipboardText(selection).catch(() => undefined)
      }
      return consumeEvent(event)
    }
    // Why darwin-only: only macOS has a real Edit-menu Cmd+V accelerator to
    // defer to. Windows/Linux draw their own titlebar with the menu hidden, so
    // a deferred Ctrl+V would never come back — handle it here, like the pane.
    const isMenuPasteChord =
      platform === 'darwin' &&
      event.metaKey &&
      !event.ctrlKey &&
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

    const action = resolvePreviewShortcutAction(event, {
      ...args.getShortcutContext(),
      optionKeyLocations: optionKeyLocations.get()
    })
    if (!action) {
      return true
    }
    switch (action.type) {
      case 'sendInput':
        if (action.consumeOptionKeyUp) {
          optionKittyReleases.armNativeDeadKey(event)
        } else if (action.optionKittyRelease) {
          optionKittyReleases.arm(
            event,
            action.optionKittyRelease,
            args.sendInput,
            () => args.getShortcutContext().getKittyKeyboardFlags(),
            getLayoutCharacterForCode
          )
        }
        args.sendInput(action.data)
        return consumeEvent(event)
      case 'trackNativeOptionDeadKey':
        optionKittyReleases.armNativeDeadKey(event)
        return true
      case 'scrollViewport':
        if (action.position === 'top') {
          terminal.scrollToTop()
        } else {
          terminal.scrollToBottom()
        }
        return consumeEvent(event)
      case 'selectAll':
        if (!event.repeat) {
          nativeOnlyShortcutTracker.armKeyDown(event)
          terminal.selectAll()
        }
        return consumeEvent(event)
      case 'switchInputSource':
        // Why: the OS owns this chord — block xterm without preventing the default.
        nativeOnlyShortcutTracker.armKeyDown(event)
        event.stopImmediatePropagation()
        return false
      // The pane-close action maps cleanly to dismissing this preview; it
      // never closes the real pane or writes bytes to its PTY.
      case 'closeActivePane':
        args.onClose?.()
        return consumeEvent(event)
      // Why: the remaining pane-scoped chords have no target in a preview.
      // Swallow them so xterm cannot encode an app chord as terminal input.
      // List them explicitly so every new action must be classified.
      case 'clearActivePane':
      case 'clearPaneTitle':
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

  return () => {
    window.removeEventListener('keydown', onModifierDown, true)
    window.removeEventListener('keyup', onModifierUp, true)
    window.removeEventListener('keypress', onNativeOnlyShortcutCompanion, true)
    window.removeEventListener('keyup', onNativeOnlyShortcutCompanion, true)
    window.removeEventListener('beforeinput', onNativeOnlyBeforeInput, true)
    window.removeEventListener('blur', onWindowBlur)
    optionKittyReleases.clear()
  }
}
