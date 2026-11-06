import { describe, expect, it } from 'vitest'
import { createInputProbeSplitter } from './fixtures/terminal-input-probe-splitter.cjs'

const PROBE = '\x1b]orca-kitty-probe\x1b\\'
const LEAKED_KEYUP = '\x1b[99;1:3u'

describe('createInputProbeSplitter', () => {
  it('recognizes a probe split across reads and keeps it out of the log', () => {
    const split = createInputProbeSplitter(PROBE)
    const first = split(`${LEAKED_KEYUP}${PROBE.slice(0, 7)}`)
    expect(first).toEqual({ logged: LEAKED_KEYUP, probes: 0 })
    expect(split(PROBE.slice(7))).toEqual({ logged: '', probes: 1 })
  })

  it('recognizes a probe delivered one byte per read', () => {
    const split = createInputProbeSplitter(PROBE)
    const results = [...PROBE].map((byte) => split(byte))
    expect(results.map((result) => result.logged).join('')).toBe('')
    expect(results.reduce((total, result) => total + result.probes, 0)).toBe(1)
  })

  it('releases a held tail once the next read shows it was not a probe', () => {
    const split = createInputProbeSplitter(PROBE)
    expect(split('a\x1b')).toEqual({ logged: 'a', probes: 0 })
    expect(split('[99;1:3u')).toEqual({ logged: LEAKED_KEYUP, probes: 0 })
  })

  it('logs input on both sides of a whole probe', () => {
    const split = createInputProbeSplitter(PROBE)
    expect(split(`x${PROBE}y`)).toEqual({ logged: 'xy', probes: 1 })
  })
})
