import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { ForegroundTerminalOutputTarget } from './pane-terminal-foreground-render-settle'

const screens = new WeakMap<ForegroundTerminalOutputTarget, TerminalKittyKeyboardModeTracker>()

export function recordTerminalOutputScreen(
  terminal: ForegroundTerminalOutputTarget,
  data: string
): void {
  let screen = screens.get(terminal)
  if (!screen) {
    screen = new TerminalKittyKeyboardModeTracker({ kittyKeyboard: false })
    screens.set(terminal, screen)
  }
  // Why: only bytes submitted to xterm count; scheduler queues can be discarded before replay.
  screen.scan(data)
}

export function isTerminalOnAlternateScreen(terminal: ForegroundTerminalOutputTarget): boolean {
  const screen = screens.get(terminal)
  // Why: parsed buffer state misses queued transitions, including replay's own screen switches.
  return screen?.hasObservedAlternateScreenSwitch
    ? screen.isAlternateScreen
    : terminal.buffer?.active?.type === 'alternate'
}
