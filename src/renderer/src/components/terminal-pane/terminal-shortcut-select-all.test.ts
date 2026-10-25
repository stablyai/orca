import { describe, expect, it, vi } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'
import { createTerminalKittyOrphanKeyupGuard } from './terminal-kitty-orphan-keyup-guard'
import { createTerminalOptionKittyReleaseTracker } from './terminal-option-kitty-release'

/** Builds an `a` keydown with no modifiers unless overridden. */
function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: 'a',
    code: 'KeyA',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('terminal select-all shortcut', () => {
  it('uses Cmd+A on macOS', () => {
    expect(resolveTerminalShortcutAction(event({ metaKey: true }), true)).toEqual({
      type: 'selectAll'
    })
    expect(resolveTerminalShortcutAction(event({ metaKey: true, repeat: true }), true)).toEqual({
      type: 'selectAll'
    })
  })

  it('uses Ctrl+Shift+A without stealing bare Ctrl+A off macOS', () => {
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true, shiftKey: true }), false)).toEqual({
      type: 'selectAll'
    })
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true }), false)).toBeNull()
  })

  it('forwards Cmd+A as kitty Super+A when the macOS pane negotiated the protocol', () => {
    const kitty = (flags: number) => () => flags
    const resolve = (overrides: Partial<TerminalShortcutEvent>, flags: number) =>
      resolveTerminalShortcutAction(
        event({ metaKey: true, ...overrides }),
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        kitty(flags)
      )

    expect(resolve({}, 1)).toEqual({ type: 'sendInput', data: '\x1b[97;9u', selectAllChord: true })
    // Why: CapsLock is not reported, matching xterm's own kitty encoder.
    expect(resolve({ getModifierState: (key) => key === 'CapsLock' }, 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[97;9u',
      selectAllChord: true
    })
    // Report-event-types apps get the repeat they asked for, and the release tracker is armed.
    expect(resolve({ repeat: true }, 3)).toEqual({
      type: 'sendInput',
      data: '\x1b[97;9:2u',
      optionKittyRelease: { flags: 3, ignoreLockModifiers: true },
      selectAllChord: true
    })
    expect(resolve({}, 0)).toEqual({ type: 'selectAll' })
  })

  it('keeps Ctrl+Shift+A as select-all off macOS even with kitty flags', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ ctrlKey: true, shiftKey: true }),
        false,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toEqual({ type: 'selectAll' })
  })

  it('sends press, repeat and exactly one matching release when the app reports event types', () => {
    const sent: string[] = []
    const releases = createTerminalOptionKittyReleaseTracker()
    const capsLock = { getModifierState: (key: string) => key === 'CapsLock' }
    // Mirrors the keydown handler: send the bytes, then arm the release it asked for.
    for (const repeat of [false, true, true]) {
      const keydown = event({ metaKey: true, repeat, ...capsLock })
      const action = resolveTerminalShortcutAction(
        keydown,
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => 3
      )
      expect(action?.type).toBe('sendInput')
      if (action?.type === 'sendInput') {
        sent.push(action.data)
        if (action.optionKittyRelease) {
          releases.arm(
            keydown,
            action.optionKittyRelease,
            (data) => sent.push(data),
            () => 3
          )
        }
      }
    }
    const keyup = event({ metaKey: true, ...capsLock })
    expect(releases.settle(keyup)).toBe(true)
    expect(releases.settle(keyup)).toBe(false)
    // Why: CapsLock is dropped on the release too, so it matches the press the app saw.
    expect(sent).toEqual(['\x1b[97;9u', '\x1b[97;9:2u', '\x1b[97;9:2u', '\x1b[97;9:3u'])
  })

  it('arms no release when the app did not ask for event types', () => {
    const keydown = event({ metaKey: true })
    const action = resolveTerminalShortcutAction(
      keydown,
      true,
      'false',
      0,
      false,
      undefined,
      undefined,
      () => 1
    )
    expect(action).toEqual({ type: 'sendInput', data: '\x1b[97;9u', selectAllChord: true })
    const releases = createTerminalOptionKittyReleaseTracker()
    const sendInput = vi.fn()
    if (action?.type === 'sendInput' && action.optionKittyRelease) {
      releases.arm(keydown, action.optionKittyRelease, sendInput, () => 1)
    }
    expect(releases.settle(event({ metaKey: true }))).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('needs the tracker because xterm drops the keyup of a press it never encoded', () => {
    const guard = createTerminalKittyOrphanKeyupGuard()
    const keyup = { type: 'keyup', code: 'KeyA', key: 'a', keyCode: 65 }
    expect(guard.filter(keyup, true, 3)).toBe(false)
  })
})
