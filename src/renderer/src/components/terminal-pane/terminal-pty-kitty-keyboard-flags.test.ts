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

    const registration = registerPtyKittyKeyboardModeTracker('pty-1', tracker)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(0)

    tracker.scan('\x1b[>1u')
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(1)

    unregisterPtyKittyKeyboardModeTracker('pty-1', registration)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(1)

    registerPtyKittyKeyboardModeTracker('pty-1', new TerminalKittyKeyboardModeTracker())
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(0)
  })

  it('does not let an earlier registration for the same tracker unregister its successor', () => {
    const tracker = new TerminalKittyKeyboardModeTracker()
    tracker.scan('\x1b[>1u')

    const staleRegistration = registerPtyKittyKeyboardModeTracker('pty-1', tracker)
    const successorRegistration = registerPtyKittyKeyboardModeTracker('pty-1', tracker)
    expect(staleRegistration).not.toBe(successorRegistration)
    unregisterPtyKittyKeyboardModeTracker('pty-1', staleRegistration)

    tracker.scan('\x1b[=2u')
    expect(tracker.flags).toBe(2)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(2)

    unregisterPtyKittyKeyboardModeTracker('pty-1', successorRegistration)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(2)
  })
})
