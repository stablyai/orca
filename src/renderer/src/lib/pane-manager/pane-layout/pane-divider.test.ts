import { describe, expect, it } from 'vitest'
import { getDividerFarOverhangPx } from '../../divider-hit-area'
import { getDividerHitSize } from './pane-divider'

describe('terminal divider grab area', () => {
  it('reaches 16px for thin lines and never shrinks the existing thickness + 6px box', () => {
    const grab = (dividerThicknessPx: number): number => {
      const box = getDividerHitSize({ dividerThicknessPx })
      return box + getDividerFarOverhangPx(box)
    }
    expect([1, 4, 10, 16, 32].map(grab)).toEqual([16, 16, 16, 22, 38])
  })
})
