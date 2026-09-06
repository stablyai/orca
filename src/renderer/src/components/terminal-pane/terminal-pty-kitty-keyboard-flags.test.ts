import { beforeEach, describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  getPtyKittyKeyboardFlags,
  registerPtyKittyKeyboardModeTracker,
  resetPtyKittyKeyboardModeTrackersForTests,
  unregisterPtyKittyKeyboardModeTracker
} from './terminal-pty-kitty-keyboard-flags'

describe('terminal PTY Kitty keyboard flags registry', () => {
  beforeEach(() => {
    resetPtyKittyKeyboardModeTrackersForTests()
  })

  it('reads the current flags for a registered PTY tracker', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()

    registerPtyKittyKeyboardModeTracker('pty-1', tracker)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(0)

    tracker.scan('\x1b[>1u')
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(1)

    unregisterPtyKittyKeyboardModeTracker('pty-1', tracker)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(0)
  })

  it('does not let a stale unregister clear a successor tracker', () => {
    const stale = new TerminalKittyKeyboardModeTracker()
    const successor = new TerminalKittyKeyboardModeTracker()
    stale.scan('\x1b[>1u')
    successor.scan('\x1b[>2u')

    registerPtyKittyKeyboardModeTracker('pty-1', stale)
    registerPtyKittyKeyboardModeTracker('pty-1', successor)
    unregisterPtyKittyKeyboardModeTracker('pty-1', stale)

    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(2)
  })
})
