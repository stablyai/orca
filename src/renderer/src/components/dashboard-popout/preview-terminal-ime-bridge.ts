import type { Terminal } from '@xterm/xterm'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { installTerminalImeCompositionTracker } from '@/components/terminal-pane/terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from '@/components/terminal-pane/terminal-ime-native-text-forwarder'

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
  if (getRendererAppPlatform() !== 'darwin') {
    return null
  }
  const compositionTracker = installTerminalImeCompositionTracker(terminal.element)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => compositionTracker?.isActive() ?? false,
    sendInput: (data) => terminal.input(data)
  })
  return {
    claimKeyEvent: (event) => forwarder?.claimKeyEvent(event) ?? false,
    dispose: () => {
      forwarder?.dispose()
      compositionTracker?.dispose()
    }
  }
}
