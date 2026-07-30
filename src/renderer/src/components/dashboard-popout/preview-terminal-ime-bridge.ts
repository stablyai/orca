import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { installTerminalImeCompositionTracker } from '@/components/terminal-pane/terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from '@/components/terminal-pane/terminal-ime-native-text-forwarder'
import { getMacNativeTextInputSourceTracker } from '@/components/terminal-pane/terminal-ime-input-source'

export type PreviewImeBridge = {
  /** True when the forwarder owns this keydown, so xterm must not encode it. */
  claimKeyEvent: (event: KeyboardEvent) => boolean
  dispose: () => void
}

/**
 * Native-text bridge for the preview terminal.
 *
 * Why: xterm's kitty encoder can encode+cancel a printable keydown before
 * Chromium commits IME/native text, silently dropping the glyph. Mirrors
 * TerminalPane's forwarder, macOS-only like the pane's install.
 */
export function installPreviewImeBridge(terminal: Terminal): PreviewImeBridge | null {
  if (getShortcutPlatform() !== 'darwin') {
    return null
  }
  // Why: prewarm the async input-source lookup before the first native-text key needs classification.
  const inputSourceTracker = getMacNativeTextInputSourceTracker()
  const compositionTracker = installTerminalImeCompositionTracker(terminal.element)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => compositionTracker?.isActive() ?? false,
    sendInput: (data) => terminal.input(data),
    getInputSourceFeatures: () => inputSourceTracker.getFeatures()
  })
  return {
    claimKeyEvent: (event) => forwarder?.claimKeyEvent(event) ?? false,
    dispose: () => {
      forwarder?.dispose()
      compositionTracker?.dispose()
    }
  }
}
