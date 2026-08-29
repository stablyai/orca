import { describe, expect, it } from 'vitest'
import {
  TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES,
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'

describe('terminal path-exists cache', () => {
  it('caches a positive result, and positives are not subject to the TTL', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistsCache(cache, 'k', true, 1000)
    expect(readTerminalPathExistsCache(cache, 'k', 1000)).toBe(true)
    expect(readTerminalPathExistsCache(cache, 'k', 1000 + 60_000)).toBe(true)
  })

  it('honors a negative result within the TTL window', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistsCache(cache, 'k', false, 1000)
    expect(readTerminalPathExistsCache(cache, 'k', 1000 + 5_000)).toBe(false)
  })

  it('re-probes (cache miss) once a negative result expires — issue #5024', () => {
    const cache: TerminalPathExistsCache = new Map()
    writeTerminalPathExistsCache(cache, 'k', false, 1000)
    // Past the negative TTL: treated as a miss so the caller re-checks the
    // filesystem (the file may have since been created).
    expect(readTerminalPathExistsCache(cache, 'k', 1000 + 10_000)).toBeUndefined()
    expect(cache.has('k')).toBe(false)
  })

  it('returns undefined for an unknown key', () => {
    expect(readTerminalPathExistsCache(new Map(), 'missing')).toBeUndefined()
  })

  it('bounds the cache to the max entry count, evicting the oldest', () => {
    const cache: TerminalPathExistsCache = new Map()
    for (let i = 0; i < TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES; i++) {
      writeTerminalPathExistsCache(cache, `k-${i}`, true, 1)
    }
    expect(cache.size).toBe(TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES)
    writeTerminalPathExistsCache(cache, 'k-fresh', true, 2)
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
