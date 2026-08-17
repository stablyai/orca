import { describe, expect, it } from 'vitest'
import {
  AUX_WINDOW_DEFAULT_SIZE,
  auxWindowFeatures,
  auxWindowFrameName,
  isAuxWindowFrameName,
  parseAuxWindowFeatures
} from './aux-window'

describe('aux window features', () => {
  it('uses one validated browsing context per detached group', () => {
    expect(auxWindowFrameName('group-1')).toBe('orca-aux-pane:group-1')
    expect(auxWindowFrameName('group-2')).not.toBe(auxWindowFrameName('group-1'))
    expect(isAuxWindowFrameName(auxWindowFrameName('group_2'))).toBe(true)
    expect(isAuxWindowFrameName('orca-aux-pane:../../unsafe')).toBe(false)
    expect(() => auxWindowFrameName('')).toThrow('Invalid detached pane group id')
  })

  it('round-trips bounds through the features string', () => {
    const bounds = { x: 120, y: 80, width: 1024, height: 700 }
    expect(parseAuxWindowFeatures(auxWindowFeatures(bounds))).toEqual(bounds)
  })

  it('omits position when there is nothing persisted yet', () => {
    const parsed = parseAuxWindowFeatures(auxWindowFeatures(null))
    expect(parsed).toEqual(AUX_WINDOW_DEFAULT_SIZE)
    expect(parsed.x).toBeUndefined()
  })

  it('rounds fractional bounds — Electron rejects non-integers', () => {
    const parsed = parseAuxWindowFeatures(
      auxWindowFeatures({ x: 10.6, y: 20.4, width: 800.5, height: 600.2 })
    )
    expect(parsed).toEqual({ x: 11, y: 20, width: 801, height: 600 })
  })

  it('ignores garbage rather than producing NaN bounds', () => {
    expect(parseAuxWindowFeatures('width=abc,height=,left=5,nonsense')).toEqual({ x: 5 })
  })
})
