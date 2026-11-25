import { describe, expect, it } from 'vitest'
import { pinnedHomeNarrowHideClassName } from './rendered-tab-strip'
import { planTabStrip } from './tab-strip-condense-plan'

// Action padding beside the strip once every pane action has folded away; the plan's room also drops the 1px border.
const ACTION_PADDING_PX = 8

function hideBelowPx(otherTabCount: number): number | null {
  const match = /@max-\[(\d+)px\]/.exec(pinnedHomeNarrowHideClassName(otherTabCount))
  return match ? Number(match[1]) : null
}

describe('pinnedHomeNarrowHideClassName', () => {
  it('hides Home only where the plan always shows the +N chip that leads with Home', () => {
    for (let count = 2; count <= 8; count++) {
      const below = hideBelowPx(count)
      expect(below).not.toBeNull()
      const ids = Array.from({ length: count }, (_, index) => `tab-${index}`)
      // Every room a narrower strip can measure, plus a pixel of slack for border rounding.
      for (let room = 0; room <= below! - ACTION_PADDING_PX; room++) {
        const plan = planTabStrip({
          width: room,
          ids,
          activeId: 'tab-0',
          previousWindowStart: null
        })
        expect(plan.mode === 'condensed' && plan.hiddenIds.length > 0).toBe(true)
      }
    }
  })

  it('keeps Home beside a single tab, which never gets a chip', () => {
    expect(hideBelowPx(1)).toBeNull()
    expect(hideBelowPx(0)).toBeNull()
  })
})
