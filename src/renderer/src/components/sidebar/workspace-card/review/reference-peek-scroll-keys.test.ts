import { describe, expect, it } from 'vitest'
import { peekScrollTarget } from './reference-peek-scroll-keys'

const list = { scrollTop: 100, clientHeight: 150, scrollHeight: 600 }
const key = (overrides: Partial<Parameters<typeof peekScrollTarget>[1]> = {}) => ({
  key: 'End',
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides
})

describe('peekScrollTarget', () => {
  it('scrolls the peek for a plain End', () => {
    expect(peekScrollTarget(list, key())).toBe(600)
  })

  it('leaves modifier chords and already-handled keys to their owners', () => {
    for (const chord of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { defaultPrevented: true }
    ]) {
      expect(peekScrollTarget(list, key(chord))).toBeUndefined()
    }
  })
})
