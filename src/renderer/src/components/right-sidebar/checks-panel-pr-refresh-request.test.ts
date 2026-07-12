import { describe, expect, it } from 'vitest'
import { resolveChecksPanelPRRefreshRequest } from './checks-panel-pr-refresh-request'

describe('resolveChecksPanelPRRefreshRequest', () => {
  it('uses an active refresh for a cached miss from before the checks panel became visible', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: false,
        cachedFetchedAt: 100,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'active', priority: 80 })
  })

  it('keeps fresh empty lookups on the background path', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: false,
        cachedFetchedAt: 200,
        panelVisibleSince: 100
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })

  it('keeps populated or unknown cache entries on the background path', () => {
    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: true,
        cachedFetchedAt: 100,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'swr', priority: 30 })

    expect(
      resolveChecksPanelPRRefreshRequest({
        cachedHasPR: null,
        cachedFetchedAt: null,
        panelVisibleSince: 200
      })
    ).toEqual({ reason: 'swr', priority: 30 })
  })
})
