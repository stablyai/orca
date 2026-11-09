import { describe, expect, it } from 'vitest'

import {
  readTerminalPathExistence,
  startTerminalPathExistsProbe,
  writeTerminalPathExistence,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'

describe('terminal path-exists cache', () => {
  it('keeps expired negatives as ordering guards for older in-flight probes', () => {
    const cache: TerminalPathExistsCache = new Map()
    const older = startTerminalPathExistsProbe(1000)
    const newer = startTerminalPathExistsProbe(2000)
    writeTerminalPathExistence(cache, 'k', false, newer)

    expect(readTerminalPathExistence(cache, 'k', 12_000)).toBeUndefined()
    writeTerminalPathExistence(cache, 'k', true, older)
    expect(cache.get('k')).toEqual({ exists: false, ...newer })

    const latest = startTerminalPathExistsProbe(12_000)
    writeTerminalPathExistence(cache, 'k', true, latest)
    expect(readTerminalPathExistence(cache, 'k', 12_000)).toBe(true)
  })

  it('ignores an older probe result that lands after a newer one', () => {
    const cache: TerminalPathExistsCache = new Map()
    const older = startTerminalPathExistsProbe(1000)
    const newer = startTerminalPathExistsProbe(2000)
    writeTerminalPathExistence(cache, 'k', true, newer)
    writeTerminalPathExistence(cache, 'k', false, older)
    expect(cache.get('k')).toEqual({ exists: true, ...newer })
    const latest = startTerminalPathExistsProbe(3000)
    writeTerminalPathExistence(cache, 'k', false, latest)
    expect(cache.get('k')).toEqual({ exists: false, ...latest })
  })

  it('orders overlapping probes that start in the same millisecond', () => {
    const cache: TerminalPathExistsCache = new Map()
    const older = startTerminalPathExistsProbe(1000)
    const newer = startTerminalPathExistsProbe(1000)
    writeTerminalPathExistence(cache, 'newer-first', false, newer)
    writeTerminalPathExistence(cache, 'newer-first', true, older)
    expect(cache.get('newer-first')).toEqual({ exists: false, ...newer })
    writeTerminalPathExistence(cache, 'older-first', false, older)
    writeTerminalPathExistence(cache, 'older-first', true, newer)
    expect(cache.get('older-first')).toEqual({ exists: true, ...newer })
  })
})
