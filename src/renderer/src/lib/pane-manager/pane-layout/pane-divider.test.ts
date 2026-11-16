import { describe, expect, it } from 'vitest'
import { getDividerHitSize } from './pane-divider'

describe('terminal divider box', () => {
  it('is at least 16px of real layout space and keeps the thickness + 6px box for thick lines', () => {
    expect(
      [1, 4, 10, 16, 32].map((dividerThicknessPx) => getDividerHitSize({ dividerThicknessPx }))
    ).toEqual([16, 16, 16, 22, 38])
  })
})
