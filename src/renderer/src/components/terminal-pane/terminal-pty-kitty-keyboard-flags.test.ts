import { beforeEach, describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  getPtyKittyKeyboardFlags,
  primeReattachedPtyKittyKeyboardModeTracker,
  registerPtyKittyKeyboardModeTracker,
  resetPtyKittyKeyboardModeTrackersForTests,
  unregisterPtyKittyKeyboardModeTracker
} from './terminal-pty-kitty-keyboard-flags'

describe('terminal PTY Kitty keyboard flags registry', () => {
  beforeEach(() => {
    resetPtyKittyKeyboardModeTrackersForTests()
  })

  it('keeps proven flags available after a pane unbinds from its PTY', () => {
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

  it('reconciles a reattached tracker with replay after priming its last proven mode', () => {
    const previous = new TerminalKittyKeyboardModeTracker()
    const previousRegistration = registerPtyKittyKeyboardModeTracker('pty-1', previous)
    previous.scan('\x1b[>1u')
    unregisterPtyKittyKeyboardModeTracker('pty-1', previousRegistration)

    const reattached = new TerminalKittyKeyboardModeTracker()
    const reattachedRegistration = registerPtyKittyKeyboardModeTracker('pty-1', reattached)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(0)

    primeReattachedPtyKittyKeyboardModeTracker('pty-1', reattachedRegistration)
    reattached.adoptSnapshot('replayed screen', undefined)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(1)

    reattached.adoptSnapshot('\x1b[=3u', undefined)
    expect(getPtyKittyKeyboardFlags('pty-1')).toBe(3)
  })
})
