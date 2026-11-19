import { describe, expect, it } from 'vitest'
import { planNewTabMenuFit } from './new-tab-menu-fit-plan'

const ROW = 36
const rows = (count: number): number => count * ROW
// The list alone gets `space` px: no chrome, no tip.
const listIn = (space: number, agents: number) =>
  planNewTabMenuFit({ available: space, chrome: 0, tip: 0, natural: rows(agents), row: ROW })

describe('planNewTabMenuFit', () => {
  it('shows a short list whole with no peek', () => {
    expect(listIn(700, 5)).toEqual({ tipHidden: false, mode: 'fit', listMaxHeight: 432 })
    expect(listIn(180, 5)).toEqual({ tipHidden: false, mode: 'fit', listMaxHeight: 180 })
  })

  it('peeks half of the last visible row once the list overflows', () => {
    expect(listIn(700, 16)).toEqual({ tipHidden: false, mode: 'peek', listMaxHeight: 414 })
    expect(listIn(250, 10)).toEqual({ tipHidden: false, mode: 'peek', listMaxHeight: 198 })
  })

  it('keeps a 2.5-row peek down to the last budget that fits it, then the menu scrolls', () => {
    expect(listIn(144, 10).listMaxHeight).toBe(126)
    expect(listIn(143, 10).listMaxHeight).toBe(90)
    expect(listIn(90, 10)).toEqual({ tipHidden: false, mode: 'peek', listMaxHeight: 90 })
    expect(listIn(89, 10)).toEqual({ tipHidden: true, mode: 'menu', listMaxHeight: null })
  })

  it('keeps the tip while the list still gets a 2.5-row peek beside it', () => {
    expect(
      planNewTabMenuFit({ available: 270, chrome: 120, tip: 60, natural: rows(16), row: ROW })
    ).toEqual({ tipHidden: false, mode: 'peek', listMaxHeight: 90 })
  })

  it('hides the tip before the list drops under 2.5 rows', () => {
    expect(
      planNewTabMenuFit({ available: 269, chrome: 120, tip: 60, natural: rows(16), row: ROW })
    ).toEqual({ tipHidden: true, mode: 'peek', listMaxHeight: 126 })
  })

  it('hides the tip when that lets the whole list fit', () => {
    expect(
      planNewTabMenuFit({ available: 240, chrome: 120, tip: 60, natural: rows(3), row: ROW })
    ).toEqual({ tipHidden: true, mode: 'fit', listMaxHeight: 120 })
  })

  it('never yields a tip that has no footprint', () => {
    expect(
      planNewTabMenuFit({ available: 269, chrome: 120, tip: 0, natural: rows(16), row: ROW })
    ).toEqual({ tipHidden: false, mode: 'peek', listMaxHeight: 126 })
  })
})
