import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { installTerminalImeCompositionTracker } from '@/components/terminal-pane/terminal-ime-composition-tracker'
import { installTerminalImeNativeTextForwarder } from '@/components/terminal-pane/terminal-ime-native-text-forwarder'
import { getMacNativeTextInputSourceTracker } from '@/components/terminal-pane/terminal-ime-input-source'
import { installTerminalImeAbandonedPreeditGuard } from '@/components/terminal-pane/terminal-ime-abandoned-preedit'
import { XTERM_COMPOSITION_SESSION_END_EVENT } from '@/components/terminal-pane/terminal-ime-composition-route'

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
export function installPreviewImeBridge(terminal: Terminal): PreviewImeBridge {
  const terminalElement = terminal.element
  // Why: the preview terminal has no composition route to arbitrate the session payload, so
  // xterm's own data event would replay an abandoned preedit into the PTY. Cancel the session
  // end instead. Not macOS-specific — any IME that empties its preedit hits this.
  const abandonedPreedit = installTerminalImeAbandonedPreeditGuard(terminalElement)
  const onSessionEnd = (event: Event): void => {
    if (abandonedPreedit.consume()) {
      event.preventDefault()
    }
  }
  terminalElement?.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)
  const disposeAbandonedPreeditGuard = (): void => {
    terminalElement?.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)
    abandonedPreedit.dispose()
  }

  if (getShortcutPlatform() !== 'darwin') {
    return { claimKeyEvent: () => false, dispose: disposeAbandonedPreeditGuard }
  }
  // Why: prewarm the async input-source lookup before the first native-text key needs classification.
  const inputSourceTracker = getMacNativeTextInputSourceTracker()
  const compositionTracker = installTerminalImeCompositionTracker(terminalElement)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement,
    isComposing: () => compositionTracker?.isActive() ?? false,
    sendInput: (data) => terminal.input(data),
    getInputSourceFeatures: () => inputSourceTracker.getFeatures()
  })
  return {
    claimKeyEvent: (event) => forwarder?.claimKeyEvent(event) ?? false,
    dispose: () => {
      disposeAbandonedPreeditGuard()
      forwarder?.dispose()
      compositionTracker?.dispose()
    }
  }
}
