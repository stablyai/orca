import { describe, expect, it } from 'vitest'
import { clampCheckDetailsHeight } from './check-details-resize'

describe('clampCheckDetailsHeight', () => {
  it('keeps the checks list resize height within readable bounds', () => {
    expect(clampCheckDetailsHeight(20)).toBe(72)
    expect(clampCheckDetailsHeight(260)).toBe(260)
    expect(clampCheckDetailsHeight(900)).toBe(520)
  })
})
