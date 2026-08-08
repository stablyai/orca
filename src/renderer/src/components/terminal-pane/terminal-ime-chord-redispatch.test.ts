// @vitest-environment happy-dom
// The recorded traces cover the ledger end to end, but they all hold their modifier through the
// replay and always carry a `code`, so these guards are unreachable from them. Pinned here
// because deleting either would leave every recorded case green while a bare press or a
// codeless event started being swallowed.
import { describe, expect, it } from 'vitest'
import {
  createTerminalImeChordRedispatchLedger,
  type ImeChordRedispatchEvent
} from './terminal-ime-chord-redispatch'

function event(overrides: Partial<ImeChordRedispatchEvent>): ImeChordRedispatchEvent {
  return {
    code: 'ArrowLeft',
    keyCode: 37,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides
  }
}

const MARKED_CHORD = event({ keyCode: 229, isComposing: true, metaKey: true })

describe('ime chord redispatch ledger', () => {
  it('retires the unmarked replay of a chord it sent', () => {
    const ledger = createTerminalImeChordRedispatchLedger()
    ledger.claimSentChord(MARKED_CHORD)

    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(true)
    // Spent: a second press of the same chord is the user's own, not a replay.
    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(false)
  })

  it.each([
    ['a different physical key', event({ code: 'ArrowRight', metaKey: true })],
    ['a bare press with no modifier', event({})],
    ['a still-marked event, which is the IME’s own', event({ keyCode: 229, isComposing: true, metaKey: true })]
  ])('does not retire %s', (_label, replay) => {
    const ledger = createTerminalImeChordRedispatchLedger()
    ledger.claimSentChord(MARKED_CHORD)

    expect(ledger.isRedispatchOfSentChord(replay)).toBe(false)
  })

  it('claims nothing from an event with no physical code', () => {
    const ledger = createTerminalImeChordRedispatchLedger()
    ledger.claimSentChord(event({ code: undefined, keyCode: 229, isComposing: true, metaKey: true }))

    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(false)
  })

  // macOS delivers the key's own keyup before the replay, with the modifier still held, so
  // that release must not end the gesture. Releasing the modifier must.
  it('survives the chord key coming up and ends when the modifier does', () => {
    const ledger = createTerminalImeChordRedispatchLedger()
    ledger.claimSentChord(MARKED_CHORD)

    ledger.onKeyUp(event({ metaKey: true }))
    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(true)

    ledger.claimSentChord(MARKED_CHORD)
    ledger.onKeyUp(event({ code: 'MetaLeft', keyCode: 91 }))
    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(false)
  })

  // A gesture interrupted by focus loss never releases its modifier, so without this the
  // carry would sit armed and eat an ordinary chord later.
  it('drops the carry on reset', () => {
    const ledger = createTerminalImeChordRedispatchLedger()
    ledger.claimSentChord(MARKED_CHORD)
    ledger.reset()

    expect(ledger.isRedispatchOfSentChord(event({ metaKey: true }))).toBe(false)
  })
})
