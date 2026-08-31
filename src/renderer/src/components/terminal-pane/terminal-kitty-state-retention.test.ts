import { afterEach, describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { TerminalKittyShortcutInputSettlement } from './terminal-kitty-shortcut-input'
import {
  forgetRetainedTerminalKittyState,
  resetRetainedTerminalKittyStatesForTests,
  restoreRetainedTerminalKittyState,
  retainTerminalKittyState
} from './terminal-kitty-state-retention'

afterEach(() => resetRetainedTerminalKittyStatesForTests())

describe('terminal kitty state retention', () => {
  it('restores proven flags when the same live PTY remounts', () => {
    const mounted = new TerminalKittyKeyboardModeTracker()
    mounted.reset()
    mounted.scan('\x1b[>1u')
    retainTerminalKittyState('pty-1', mounted)

    const remounted = new TerminalKittyKeyboardModeTracker()
    remounted.resetForSnapshot()
    restoreRetainedTerminalKittyState('pty-1', remounted)

    expect(remounted.snapshotFlags).toBe(1)
  })

  it('settles deferred Shift+Enter from a retained park baseline', () => {
    const mounted = new TerminalKittyKeyboardModeTracker()
    mounted.reset()
    mounted.scan('\x1b[>1u')
    retainTerminalKittyState('pty-1', mounted)

    const remounted = new TerminalKittyKeyboardModeTracker()
    remounted.resetForSnapshot()
    const settlement = new TerminalKittyShortcutInputSettlement()
    const sent: string[] = []
    settlement.dispatch({ kitty: '\x1b[13;2u', legacy: '\x1b\r' }, (data) => sent.push(data))

    restoreRetainedTerminalKittyState('pty-1', remounted)
    settlement.settle(remounted.flags)

    expect(sent).toEqual(['\x1b[13;2u'])
  })

  it('does not carry state into a fresh or exited PTY', () => {
    const mounted = new TerminalKittyKeyboardModeTracker()
    mounted.reset()
    mounted.scan('\x1b[>1u')
    retainTerminalKittyState('pty-1', mounted)
    forgetRetainedTerminalKittyState('pty-1')

    const fresh = new TerminalKittyKeyboardModeTracker()
    fresh.resetForSnapshot()
    restoreRetainedTerminalKittyState('pty-1', fresh)

    expect(fresh.snapshotFlags).toBeUndefined()
  })
})
