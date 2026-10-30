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
  /** Read the live kitty mirror once per commit; a default zero would send legacy text to TUIs requiring CSI-u. */
  getKittyKeyboardFlags: () => number
}

/** Bypass xterm’s printable-keydown cancellation until native text commits; forward the full kitty flag word unchanged to shared encoding policy. */
export function installPreviewImeBridge(
  terminal: Terminal,
  options: PreviewImeBridgeOptions
): PreviewImeBridge | null {
  const platform = getShortcutPlatform()
  const isDesktopLinux = platform === 'linux' && !/Android|CrOS/.test(navigator.userAgent)
  if (platform !== 'darwin' && !isDesktopLinux) {
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
