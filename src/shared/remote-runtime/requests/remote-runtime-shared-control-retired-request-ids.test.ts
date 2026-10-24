import { describe, expect, it } from 'vitest'
import { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'

describe('SharedControlRetiredRequestIds', () => {
  it('retains recent ids through repeated late frames and expires them', () => {
    let now = 1_000
    const ids = new SharedControlRetiredRequestIds({
      ttlMs: 100,
      now: () => now
    })

    ids.retire('request-1')
    expect(ids.has('request-1')).toBe(true)
    expect(ids.has('request-1')).toBe(true)

    now += 101
    expect(ids.has('request-1')).toBe(false)
    expect(ids.size).toBe(0)
  })

  it('evicts the oldest ids at its configured bound', () => {
    const ids = new SharedControlRetiredRequestIds({ maxIds: 2 })

    ids.retire('request-1')
    ids.retire('request-2')
    ids.retire('request-3')

    expect(ids.size).toBe(2)
    expect(ids.has('request-1')).toBe(false)
    expect(ids.has('request-2')).toBe(true)
    expect(ids.has('request-3')).toBe(true)
  })

  it('refreshes an existing id to the newest eviction rank', () => {
    const ids = new SharedControlRetiredRequestIds({ maxIds: 2 })

    ids.retire('request-1')
    ids.retire('request-2')
    ids.retire('request-1')
    ids.retire('request-3')

    expect(ids.has('request-1')).toBe(true)
    expect(ids.has('request-2')).toBe(false)
    expect(ids.has('request-3')).toBe(true)
  })

  it('expires ids correctly after the clock moves backward', () => {
    let now = 1_000
    const ids = new SharedControlRetiredRequestIds({
      ttlMs: 100,
      now: () => now
    })

    ids.retire('request-1')
    now = 900
    ids.retire('request-2')
    now = 1_001

    expect(ids.has('request-1')).toBe(true)
    expect(ids.has('request-2')).toBe(false)
  })
})
