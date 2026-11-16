import { describe, expect, it } from 'vitest'
import { antigravityPublishedPrices } from './antigravity-published-prices'

describe('Antigravity published Standard API reference prices', () => {
  it('prices Hydrogen effort variants at its own rate', () => {
    expect(antigravityPublishedPrices('gemini-4-hydrogen-high', '2026-11-16T00:00:00Z')).toEqual({
      inputUsdPerMillion: 1.5,
      cacheReadUsdPerMillion: 0.075,
      outputUsdPerMillion: 7.5
    })
    expect(antigravityPublishedPrices('gemini-4-hydrogen-xhigh', '2026-12-01T00:00:00Z')).toEqual({
      inputUsdPerMillion: 1.5,
      cacheReadUsdPerMillion: 0.075,
      outputUsdPerMillion: 7.5
    })
  })

  it('uses event time for the Carbon and Argon December price switch', () => {
    expect(antigravityPublishedPrices('gemini-4-carbon-high', '2026-11-30T23:59:59Z')).toEqual({
      inputUsdPerMillion: 2,
      cacheReadUsdPerMillion: 0.1,
      outputUsdPerMillion: 10
    })
    expect(antigravityPublishedPrices('gemini-4-carbon-high', '2026-12-01T00:00:00Z')).toEqual({
      inputUsdPerMillion: 4,
      cacheReadUsdPerMillion: 0.2,
      outputUsdPerMillion: 20
    })
    expect(
      antigravityPublishedPrices('gemini-4-argon-medium', '2026-11-30T19:30:00-05:00')
    ).toEqual({ inputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 20 })
  })

  it('keeps Flash separate and switches its rate in January', () => {
    expect(antigravityPublishedPrices('gemini-3.8-flash-low', '2026-12-31T23:59:59Z')).toEqual({
      inputUsdPerMillion: 0.75,
      cacheReadUsdPerMillion: 0.075,
      outputUsdPerMillion: 3.75
    })
    expect(antigravityPublishedPrices('gemini-3.8-flash', '2027-01-01T00:00:00Z')).toEqual({
      inputUsdPerMillion: 1.5,
      cacheReadUsdPerMillion: 0.15,
      outputUsdPerMillion: 7.5
    })
  })

  it('does not guess missing dates, unknown aliases or unsupported efforts', () => {
    expect(antigravityPublishedPrices(null, '2026-11-16T00:00:00Z')).toBeUndefined()
    expect(antigravityPublishedPrices('gemini-4-hydrogen-high', null)).toBeUndefined()
    expect(antigravityPublishedPrices('gemini-4-hydrogen-high', 'invalid')).toBeUndefined()
    expect(
      antigravityPublishedPrices('gemini-4-carbon-xhigh', '2026-11-16T00:00:00Z')
    ).toBeUndefined()
    expect(
      antigravityPublishedPrices('prefix-gemini-4-hydrogen-high', '2026-11-16T00:00:00Z')
    ).toBeUndefined()
    expect(
      antigravityPublishedPrices('gemini-pro-orchestrator', '2026-11-16T00:00:00Z')
    ).toBeUndefined()
    expect(
      antigravityPublishedPrices('gemini-flash-worker-agy', '2026-11-16T00:00:00Z')
    ).toBeUndefined()
  })
})
