import { describe, expect, it } from 'vitest'
import { reconnectDelay, RECONNECT_DELAYS_MS, statusForBuild } from './use-build-log-stream'

describe('reconnectDelay', () => {
  it('backs off, then gives up so the user can reconnect by hand', () => {
    expect(reconnectDelay(0)).toBe(1_000)
    expect(reconnectDelay(3)).toBe(8_000)
    expect(reconnectDelay(RECONNECT_DELAYS_MS.length - 1)).toBe(30_000)
    expect(reconnectDelay(RECONNECT_DELAYS_MS.length)).toBeNull()
  })
})

describe('statusForBuild', () => {
  const ended = { key: 'env_1:bld_a', state: 'ended' as const, error: null, build: null }

  it('reports the stored status for the build it belongs to', () => {
    expect(statusForBuild(ended, 'env_1', 'bld_a').state).toBe('ended')
  })

  it("never lets a previous build's status leak onto a newly selected one", () => {
    // The failure auto-scroll gates on 'ended'; a stale 'ended' would fire it before the log loads.
    expect(statusForBuild(ended, 'env_1', 'bld_b')).toEqual({
      state: 'connecting',
      error: null,
      build: null
    })
    expect(statusForBuild(ended, null, null).state).toBe('connecting')
  })
})
