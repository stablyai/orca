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
import { readTerminalClipboardSelection } from '@/components/terminal-pane/terminal-clipboard-selection-text'
import { isAppOwnedCopyChord } from '@/components/terminal-pane/xterm-bypass-policy'
import { firesNativePasteEvent } from '@/components/terminal-pane/terminal-clipboard-event-paste'

/** Compose IME, clipboard and pane policy while leaving native paste to its ClipboardEvent. */
export function installPreviewTerminalKeyHandler(args: {
  terminal: Terminal
  claimImeKeyEvent: (event: KeyboardEvent) => boolean
  pasteClipboardText: (activeElement: Element | null, source: 'keyboard') => void
  sendInput: (data: string) => void
  requestClose?: () => void
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

  // Record Option location on the modifier event; character key events report their own location.
  const optionKeyLocations = createOptionKeyLocationTracker()
  const optionKittyReleases = createTerminalOptionKittyReleaseTracker()
  const onModifierDown = (event: KeyboardEvent): void => {
    optionKeyLocations.keyDown(event)
  }
  const onModifierUp = (event: KeyboardEvent): void => {
    optionKeyLocations.keyUp(event)
  }
  const onWindowBlur = (): void => {
    consumedClipboardKeys.clear()
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
    // Prefetch the async layout map before the first kitty Option chord needs its base key.
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
      if (
        isAppOwnedCopyChord(event, {
          isMac: platform === 'darwin',
          hasSelection: terminal.hasSelection(),
          kittyKeyboardFlags: args.getShortcutContext().getKittyKeyboardFlags()
        })
      ) {
        return true
      }
      const selection = readTerminalClipboardSelection(terminal)
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
    const nativePaste = firesNativePasteEvent(event, platform === 'darwin')
    if (keybindingMatchesAction('terminal.paste', event, platform, keybindings)) {
      const keyIdentity = event.code || event.key
      const firstKeydown = !consumedClipboardKeys.has(keyIdentity)
      consumedClipboardKeys.add(keyIdentity)
      if (nativePaste) {
        return false
      }
      if (firstKeydown) {
        args.pasteClipboardText(document.activeElement, 'keyboard')
      }
      return consumeEvent(event)
    }

    if (nativePaste) {
      consumedClipboardKeys.add(event.code || event.key)
    }
    const action = resolvePreviewShortcutAction(event, {
      ...args.getShortcutContext(),
      optionKeyLocations: optionKeyLocations.get()
    })
    if (!action) {
      return nativePaste ? consumeEvent(event) : true
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
      // Why: the focused terminal swallows Escape and Tab, so Cmd/Ctrl+W is the only keyboard exit.
      case 'closeActivePane':
        args.requestClose?.()
        return consumeEvent(event)
      // Swallow pane-only actions rather than encoding shell bytes such as Ctrl+D; list each so new actions require explicit classification.
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
