import { describe, expect, it } from 'vitest'
import { oscStringOpenAfter } from './terminal-osc-string-state'

describe('oscStringOpenAfter', () => {
  it('opens on an introducer and closes on BEL or ST', () => {
    expect(oscStringOpenAfter('text \x1b]0;title', false)).toBe(true)
    expect(oscStringOpenAfter('\x1b]0;title\x07', false)).toBe(false)
    expect(oscStringOpenAfter('\x1b]0;title\x1b\\', false)).toBe(false)
  })

  it('is aborted by CAN, SUB or any other escape', () => {
    expect(oscStringOpenAfter('\x1b]0;ti\x18', false)).toBe(false)
    expect(oscStringOpenAfter('\x1b]0;ti\x1a', false)).toBe(false)
    expect(oscStringOpenAfter('\x1b]0;ti\x1b[0m', false)).toBe(false)
  })

  it('carries an open string across reads until it ends', () => {
    expect(oscStringOpenAfter('more title', true)).toBe(true)
    expect(oscStringOpenAfter('le\x07after', true)).toBe(false)
    expect(oscStringOpenAfter('plain output', false)).toBe(false)
  })

  it('looks only at the last introducer', () => {
    expect(oscStringOpenAfter('\x1b]0;a\x07\x1b]2;b', false)).toBe(true)
    expect(oscStringOpenAfter('\x1b]0;a\x1b]2;b\x07', false)).toBe(false)
  })
})
