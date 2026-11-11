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
