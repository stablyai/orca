import { describe, expect, it, vi } from 'vitest'
import { createTerminalOptionKittyReleaseTracker } from './terminal-option-kitty-release'

function keyboardEvent(
  overrides: Partial<{
    key: string
    code: string
    shiftKey: boolean
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    repeat: boolean
    getModifierState: (key: string) => boolean
  }>
) {
  return {
    key: 'q',
    code: 'KeyQ',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    ...overrides
  }
}

describe('terminal Option kitty releases', () => {
  it('consumes a native dead-key release without emitting a protocol event', () => {
    const tracker = createTerminalOptionKittyReleaseTracker()
    tracker.armNativeDeadKey(keyboardEvent({ key: 'Dead', code: 'KeyE', altKey: true }))

    expect(tracker.settle(keyboardEvent({ key: '´', code: 'KeyE', altKey: true }))).toBe(true)
    expect(tracker.settle(keyboardEvent({ key: '´', code: 'KeyE', altKey: true }))).toBe(false)
  })

  it('uses live keyup modifiers and current alternate-key flags', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    const layout = (code: string, shifted: boolean): string | undefined =>
      code === 'Digit7' ? (shifted ? '/' : '7') : undefined
    tracker.arm(
      keyboardEvent({ key: '\\', code: 'Digit7', shiftKey: true, altKey: true }),
      { flags: 2 },
      sendInput,
      () => 6,
      layout
    )

    expect(
      tracker.settle(keyboardEvent({ key: '7', code: 'Digit7', shiftKey: false, altKey: true }))
    ).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b[55;3:3u')
  })

  it('keeps the press identity after the keyboard layout is invalidated', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    let layoutAvailable = true
    const layout = (code: string): string | undefined =>
      layoutAvailable && code === 'KeyQ' ? 'a' : undefined
    tracker.arm(
      keyboardEvent({ key: '@', code: 'KeyQ', altKey: true }),
      { flags: 2 },
      sendInput,
      () => 2,
      layout
    )

    layoutAvailable = false
    tracker.settle(keyboardEvent({ key: 'q', code: 'KeyQ', altKey: true }))
    expect(sendInput).toHaveBeenCalledWith('\x1b[97;3:3u')
  })

  it('keeps the press identity when NumLock changes before keyup', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    tracker.arm(
      keyboardEvent({
        key: '4',
        code: 'Numpad4',
        altKey: true,
        getModifierState: (modifier) => modifier === 'NumLock'
      }),
      { flags: 2 },
      sendInput,
      () => 2
    )

    tracker.settle(
      keyboardEvent({
        key: 'ArrowLeft',
        code: 'Numpad4',
        altKey: true,
        getModifierState: () => false
      })
    )
    expect(sendInput).toHaveBeenCalledWith('\x1b[57403;3:3u')
  })

  it('keeps shifted unresolved punctuation identity after Shift comes up', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    tracker.arm(
      keyboardEvent({ key: '>', code: 'IntlBackslash', shiftKey: true }),
      { flags: 2 },
      sendInput,
      () => 2
    )

    tracker.settle(keyboardEvent({ key: '<', code: 'IntlBackslash', shiftKey: false }))
    expect(sendInput).toHaveBeenCalledWith('\x1b[62;1:3u')
  })

  it('drops Alt when Option came up before the character key', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    tracker.arm(
      keyboardEvent({ key: 'ƒ', code: 'KeyF', altKey: true }),
      { flags: 2 },
      sendInput,
      () => 2
    )

    tracker.settle(keyboardEvent({ key: 'f', code: 'KeyF', altKey: false }))
    expect(sendInput).toHaveBeenCalledWith('\x1b[102;1:3u')
  })

  it('owns the keyup but drops its bytes after event reporting is popped', () => {
    const sendInput = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    tracker.arm(keyboardEvent({ key: '@', altKey: true }), { flags: 2 }, sendInput, () => 0)

    expect(tracker.settle(keyboardEvent({ key: 'q', altKey: true }))).toBe(true)
    expect(sendInput).not.toHaveBeenCalled()
    expect(tracker.settle(keyboardEvent({ key: 'q', altKey: true }))).toBe(false)
  })

  it('keeps the first release owner when auto-repeat keydowns are re-armed', () => {
    const firstSender = vi.fn()
    const repeatSender = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    const press = keyboardEvent({ key: '@', altKey: true })
    tracker.arm(press, { flags: 2 }, firstSender, () => 2)
    tracker.arm({ ...press, repeat: true }, { flags: 2 }, repeatSender, () => 2)

    tracker.settle(keyboardEvent({ key: 'q', altKey: true }))
    expect(firstSender).toHaveBeenCalledWith('\x1b[113;3:3u')
    expect(repeatSender).not.toHaveBeenCalled()
  })

  it('lets a fresh press replace an orphaned release owner for the same key', () => {
    const staleSender = vi.fn()
    const freshSender = vi.fn()
    const tracker = createTerminalOptionKittyReleaseTracker()
    const press = keyboardEvent({ key: '@', altKey: true })
    tracker.arm(press, { flags: 2 }, staleSender, () => 2)
    tracker.arm(press, { flags: 2 }, freshSender, () => 2)

    tracker.settle(keyboardEvent({ key: 'q', altKey: true }))
    expect(staleSender).not.toHaveBeenCalled()
    expect(freshSender).toHaveBeenCalledWith('\x1b[113;3:3u')
  })
})
