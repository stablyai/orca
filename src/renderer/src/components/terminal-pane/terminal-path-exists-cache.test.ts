import { describe, expect, it } from 'vitest'
import {
  TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES,
  getTerminalPathExistsCacheKey,
  readTerminalPathExistence,
  startTerminalPathExistsProbe,
  writeTerminalPathExistence,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'

describe('terminal path-exists cache', () => {
  it('caches a positive result, and positives are not subject to the TTL', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistence(cache, 'k', true, startTerminalPathExistsProbe(1000))
    expect(readTerminalPathExistence(cache, 'k', 1000)).toBe(true)
    expect(readTerminalPathExistence(cache, 'k', 1000 + 60_000)).toBe(true)
  })

  it('honors a negative result within the TTL window', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistence(cache, 'k', false, startTerminalPathExistsProbe(1000))
    expect(readTerminalPathExistence(cache, 'k', 1000 + 5_000)).toBe(false)
  })

  it('re-probes (cache miss) once a negative result expires — issue #5024', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistence(cache, 'k', false, startTerminalPathExistsProbe(1000))
    // Past the negative TTL: treated as a miss so the caller re-checks the
    // filesystem (the file may have since been created).
    expect(readTerminalPathExistence(cache, 'k', 1000 + 10_000)).toBeUndefined()
    expect(cache.has('k')).toBe(true)
  })

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

  it('returns undefined for an unknown key', () => {
    expect(readTerminalPathExistence(new Map(), 'missing')).toBeUndefined()
  })

  it('bounds the cache to the max entry count, evicting the oldest', () => {
    const cache: TerminalPathExistsCache = new Map()
    for (let i = 0; i < TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES; i++) {
      writeTerminalPathExistence(cache, `k-${i}`, true, startTerminalPathExistsProbe(1))
    }
    expect(cache.size).toBe(TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES)
    writeTerminalPathExistence(cache, 'k-fresh', true, startTerminalPathExistsProbe(2))
    expect(cache.size).toBe(TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES)
    expect(cache.has('k-0')).toBe(false)
    expect(cache.has('k-fresh')).toBe(true)
  })

  it('scopes keys by SSH connection and runtime environment', () => {
    const abs = '/repo/file.ts'
    expect(getTerminalPathExistsCacheKey({ absolutePath: abs })).toBe(`active\0${abs}`)
    expect(getTerminalPathExistsCacheKey({ absolutePath: abs, connectionId: 'ssh-1' })).toBe(
      `ssh:ssh-1\0${abs}`
    )
    expect(
      getTerminalPathExistsCacheKey({
        absolutePath: abs,
        isRemoteRuntimePath: true,
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe(`env-1\0${abs}`)
  })
})
