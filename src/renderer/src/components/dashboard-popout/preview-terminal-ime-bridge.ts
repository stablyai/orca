import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { installTerminalImeCompositionTracker } from '@/components/terminal-pane/terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from '@/components/terminal-pane/terminal-ime-native-text-forwarder'

export type PreviewImeBridge = {
  /** True when the forwarder owns this keydown, so xterm must not encode it. */
  claimKeyEvent: (event: KeyboardEvent) => boolean
  dispose: () => void
}

export type PreviewImeBridgeOptions = {
  /**
   * The preview's live kitty mirror, read once per commit. Required, not
   * optional: omitting it evaluated every commit at flags `0`, so a Preview on
   * a bit-3 TUI silently sent legacy text the app had declined.
   */
  getKittyKeyboardFlags: () => number
}

/**
 * Native-text bridge for the preview terminal.
 *
 * Why: xterm's kitty encoder can encode+cancel a printable keydown before
 * Chromium commits IME/native text, silently dropping the glyph. Mirrors
 * TerminalPane's forwarder, macOS-only like the pane's install.
 *
 * Bit policy stays in terminal-ime-kitty-commit-encoding.ts: the getter is
 * forwarded unchanged, never masked or reduced to a boolean.
 */
export function installPreviewImeBridge(
  terminal: Terminal,
  options: PreviewImeBridgeOptions
): PreviewImeBridge | null {
  if (getShortcutPlatform() !== 'darwin') {
    return null
  }
  const compositionTracker = installTerminalImeCompositionTracker(terminal.element)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => compositionTracker?.isActive() ?? false,
    sendInput: (data) => terminal.input(data),
    getKittyKeyboardFlags: options.getKittyKeyboardFlags
  })
  return {
    claimKeyEvent: (event) => forwarder?.claimKeyEvent(event) ?? false,
    dispose: () => {
      forwarder?.dispose()
      compositionTracker?.dispose()
    }
  }
}
