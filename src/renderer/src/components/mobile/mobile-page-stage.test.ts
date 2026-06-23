import { describe, expect, it } from 'vitest'
import { shouldShowPairedAfterDeviceRefresh } from './mobile-page-stage'

describe('mobile page stage', () => {
  it('shows paired after a device refresh adds a phone during pairing flow', () => {
    expect(
      shouldShowPairedAfterDeviceRefresh({
        stage: 'flow',
        deviceCountAtPairStart: 1,
        nextDeviceCount: 2
      })
    ).toBe(true)
  })

  it('keeps the flow while the refreshed device count is unchanged', () => {
    expect(
      shouldShowPairedAfterDeviceRefresh({
        stage: 'flow',
        deviceCountAtPairStart: 1,
        nextDeviceCount: 1
      })
    ).toBe(false)
  })

  it('does not switch stages without a pairing baseline', () => {
    expect(
      shouldShowPairedAfterDeviceRefresh({
        stage: 'flow',
        deviceCountAtPairStart: null,
        nextDeviceCount: 1
      })
    ).toBe(false)
  })

  it('only auto-switches from the pairing flow', () => {
    expect(
      shouldShowPairedAfterDeviceRefresh({
        stage: 'paired',
        deviceCountAtPairStart: 1,
        nextDeviceCount: 2
      })
    ).toBe(false)
  })
})
