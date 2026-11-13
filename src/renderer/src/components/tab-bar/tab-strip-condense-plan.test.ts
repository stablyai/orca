import { describe, expect, it } from 'vitest'
import { planTabStrip } from './tab-strip-condense-plan'

const SIX = ['a', 'b', 'c', 'd', 'e', 'f']

function plan(
  width: number,
  ids = SIX,
  activeId: string | null = 'c',
  previous: number | null = null
) {
  return planTabStrip({ width, ids, activeId, previousWindowStart: previous })
}

describe('planTabStrip', () => {
  it('keeps every title while each tab gets 80px', () => {
    expect(plan(480)).toEqual({ mode: 'titled' })
  })

  it('turns inactive tabs into icons once a title would drop under 80px', () => {
    expect(plan(479)).toMatchObject({
      activeWidth: 200,
      iconIds: ['a', 'b', 'd', 'e', 'f'],
      hiddenIds: [],
      chipOnly: false
    })
    expect(plan(264)).toMatchObject({ activeWidth: 104, hiddenIds: [] })
  })

  it('hides tabs outside a window around the active once it would drop under 104px', () => {
    expect(plan(263)).toMatchObject({
      activeWidth: 129,
      iconIds: ['b', 'd', 'e'],
      hiddenIds: ['a', 'f'],
      windowStart: 1
    })
    expect(plan(174)).toMatchObject({
      activeWidth: 104,
      iconIds: ['d'],
      hiddenIds: ['a', 'b', 'e', 'f']
    })
    expect(plan(172)).toMatchObject({
      activeWidth: 134,
      iconIds: [],
      hiddenIds: ['a', 'b', 'd', 'e', 'f']
    })
  })

  it('shrinks the active title beside the chip, then makes it an icon under 56px', () => {
    expect(plan(141)).toMatchObject({ activeWidth: 103, iconIds: [] })
    expect(plan(94)).toMatchObject({ activeWidth: 56, iconIds: [] })
    expect(plan(93)).toMatchObject({ activeWidth: 32, iconIds: ['c'], chipOnly: false })
    expect(plan(70)).toMatchObject({ iconIds: ['c'], chipOnly: false })
  })

  it('leaves only the chip when even an icon beside it does not fit', () => {
    expect(plan(69)).toMatchObject({ chipOnly: true, hiddenIds: SIX })
  })

  it('never hides exactly one tab', () => {
    expect(plan(97, ['a', 'b'], 'a')).toMatchObject({
      activeWidth: 65,
      iconIds: ['b'],
      hiddenIds: []
    })
    expect(plan(70, ['a', 'b'], 'a')).toMatchObject({ iconIds: ['a', 'b'], hiddenIds: [] })
    expect(plan(63, ['a', 'b'], 'a')).toMatchObject({ chipOnly: true })
  })

  it('gives a single tab the whole strip without a chip', () => {
    expect(plan(60, ['a'], 'a')).toMatchObject({ activeWidth: 60, iconIds: [], hiddenIds: [] })
    expect(plan(50, ['a'], 'a')).toMatchObject({ activeWidth: 50, iconIds: ['a'] })
  })

  it('slides the window the minimum distance to reach a newly active tab', () => {
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(plan(250, eight, 'b')).toMatchObject({ windowStart: 0, hiddenIds: ['e', 'f', 'g', 'h'] })
    expect(plan(250, eight, 'f', 0)).toMatchObject({
      windowStart: 2,
      iconIds: ['c', 'd', 'e'],
      hiddenIds: ['a', 'b', 'g', 'h']
    })
    expect(plan(250, eight, 'd', 2)).toMatchObject({ windowStart: 2 })
  })
})
