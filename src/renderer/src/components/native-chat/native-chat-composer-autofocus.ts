import { shouldFocusMobileDriverAction } from '../terminal-pane/mobile-driver-overlay-focus'

/**
 * Gate for the chat composer's autofocus effect (new session, switching to an
 * existing chat tab/pane). `chatSurfaceActive` is the tab/pane visibility
 * trigger (mirrors CodexRestartChip's `shouldFocus`); `composerEnabled`
 * covers the not-yet-bound-pty case, where focus() would otherwise be a
 * no-op and must be retried once the composer enables. Politeness (don't
 * steal focus from a real input elsewhere) reuses the same check as the
 * mobile-driver recovery overlay.
 */
export function shouldAutofocusNativeChatComposer(args: {
  chatSurfaceActive: boolean
  composerEnabled: boolean
  activeElement: unknown
  body?: unknown
  focusScope?: unknown
}): boolean {
  if (!args.chatSurfaceActive || !args.composerEnabled) {
    return false
  }
  return shouldFocusMobileDriverAction(args.activeElement, args.body, args.focusScope)
}
