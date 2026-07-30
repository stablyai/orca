import { describe, expect, it } from 'vitest'
import {
  armTerminalImeDeletionReleaseGuard,
  consumeTerminalImeDeletionRelease,
  createTerminalImeDeletionReleaseGuard
} from './terminal-ime-deletion-release-guard'
import { event } from './xterm-bypass-event-fixture'

describe('terminal IME deletion release guard', () => {
  it('consumes the ordinary release paired with a native Windows IME deletion', () => {
    const guard = createTerminalImeDeletionReleaseGuard()
    armTerminalImeDeletionReleaseGuard(
      guard,
      event({ key: 'Process', code: 'Backspace', keyCode: 229 }),
      true,
      10
    )

    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Process', code: 'Backspace', keyCode: 229 }),
        20
      )
    ).toBe(false)
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8 }),
        21
      )
    ).toBe(true)
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8 }),
        22
      )
    ).toBe(false)
  })

  it('supports logical deletion keys when physical code is unavailable', () => {
    const guard = createTerminalImeDeletionReleaseGuard()
    armTerminalImeDeletionReleaseGuard(
      guard,
      event({ key: 'Backspace', code: '', keyCode: 229 }),
      true,
      10
    )
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Process', code: '', keyCode: 229 }),
        20
      )
    ).toBe(false)
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Backspace', code: '', keyCode: 8 }),
        21
      )
    ).toBe(true)
  })

  it('expires or clears ownership before unrelated keyboard input', () => {
    const guard = createTerminalImeDeletionReleaseGuard()
    const deletion = event({ key: 'Process', code: 'Delete', keyCode: 229 })
    armTerminalImeDeletionReleaseGuard(guard, deletion, true, 10)
    expect(consumeTerminalImeDeletionRelease(guard, event({ key: 'a', code: 'KeyA' }), 20)).toBe(
      false
    )
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Delete', code: 'Delete', keyCode: 46 }),
        21
      )
    ).toBe(false)

    armTerminalImeDeletionReleaseGuard(guard, deletion, true, 10)
    expect(
      consumeTerminalImeDeletionRelease(
        guard,
        event({ type: 'keyup', key: 'Delete', code: 'Delete', keyCode: 46 }),
        1_011
      )
    ).toBe(false)
  })

  it('does not arm outside an active composition', () => {
    const guard = createTerminalImeDeletionReleaseGuard()
    armTerminalImeDeletionReleaseGuard(
      guard,
      event({ key: 'Process', code: 'Backspace', keyCode: 229 }),
      false,
      10
    )
    expect(guard.key).toBeUndefined()
  })
})
