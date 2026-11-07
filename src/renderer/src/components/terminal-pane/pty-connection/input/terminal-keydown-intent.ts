import {
  isCtrlCKeyEvent,
  isPlainEscapeKeyEvent
} from '../../input/keyboard/agent-interrupt-key-event'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installTerminalKeydownIntent(session: ConnectPanePtySession): void {
  session.onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      session.setPendingTerminalInputIntent('plain-escape')
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && session.pane.terminal.hasSelection()) {
        return
      }
      session.setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only keydowns that will produce real terminal input reach the sample
    // below; modifier-only presses, autorepeat, and copy chords do not.
    if (
      event.repeat ||
      event.key === 'Alt' ||
      event.key === 'AltGraph' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Shift'
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      session.pane.terminal.hasSelection()
    ) {
      return
    }
    // Enter at shell foreground backs up OSC 133;C hooks replaced by shell frameworks; confirm only panes without live agent identity.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      session.sampleVisiblePaneForegroundAgent()
    }
  }
  // Infer from focused key events; raw bytes conflate Escape with Alt/meta and programmatic writes must not clear status.
  session.terminalKeyTarget = session.pane.terminal.element ?? session.pane.container
  session.terminalKeyTargetSupportsEvents =
    typeof session.terminalKeyTarget?.addEventListener === 'function' &&
    typeof session.terminalKeyTarget?.removeEventListener === 'function'
  if (session.terminalKeyTargetSupportsEvents) {
    session.terminalKeyTarget.addEventListener('keydown', session.onTerminalKeyDown, {
      capture: true
    })
  }
}
