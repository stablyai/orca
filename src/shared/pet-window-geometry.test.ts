import { describe, expect, it } from 'vitest'
import { PET_SIZE_MAX } from './pet-types'
import {
  PET_WINDOW_MARGIN,
  defaultPetWindowPosition,
  petWindowSizeForPetSize
} from './pet-window-geometry'

describe('petWindowSizeForPetSize', () => {
  it('leaves room on every side for the bob float', () => {
    expect(petWindowSizeForPetSize(180)).toBe(180 + PET_WINDOW_MARGIN * 2)
  })

  it('caps at the largest pet so a corrupt persisted size cannot size a giant window', () => {
    expect(petWindowSizeForPetSize(10_000)).toBe(PET_SIZE_MAX + PET_WINDOW_MARGIN * 2)
  })

  it('rounds fractional sizes — window bounds are whole pixels', () => {
    expect(Number.isInteger(petWindowSizeForPetSize(123.4))).toBe(true)
  })
})

describe('defaultPetWindowPosition', () => {
  it('lands in the work area bottom-right, offset from the display origin', () => {
    const position = defaultPetWindowPosition({ x: 100, y: 50, width: 1000, height: 800 }, 200)
    expect(position).toEqual({ x: 100 + 1000 - 200 - 48, y: 50 + 800 - 200 - 24 })
  })

  it('never places the pet before the work area origin on a display smaller than the window', () => {
    const position = defaultPetWindowPosition({ x: 0, y: 0, width: 120, height: 120 }, 400)
    expect(position).toEqual({ x: 0, y: 0 })
  })
})
