import { describe, expect, it } from 'vitest'
import { pickBotItemDetailsCut } from './bot-item-details-cut'

// Offsets as readBotItemDetailsGeometry reports them: block ends, whole link rows and the bottoms of
// visible lines, never a label's own line.
describe('pickBotItemDetailsCut', () => {
  it('shows everything when it fits', () => {
    expect(pickBotItemDetailsCut({ cuts: [40, 90], height: 90 }, 120.6)).toBe(120)
  })

  it('rounds a fractional cut up, never above the line it keeps', () => {
    // Two runs on one line end at 70.2 and 71.6: the reader merges them into one line ending at 71.6.
    const geometry = { cuts: [33.4, 52.5, 71.6, 120], height: 160 }
    expect(pickBotItemDetailsCut(geometry, 71.9)).toBe(72)
    expect(pickBotItemDetailsCut(geometry, 71)).toBe(53)
  })

  it('cuts at the last legal cut that fits, never in between', () => {
    // Description lines end at 33, 52, 71; its block at 71. Done when's first line ends at 113.
    const geometry = { cuts: [33, 52, 71, 71, 113, 132, 132], height: 200 }
    expect(pickBotItemDetailsCut(geometry, 80)).toBe(71)
    expect(pickBotItemDetailsCut(geometry, 112.5)).toBe(71)
    expect(pickBotItemDetailsCut(geometry, 113.4)).toBe(113)
  })

  it('cuts an expanded first description, with no marks of its own, on a whole line', () => {
    // Lines end at 33.5, 52.5, 71.5, 90.5 (the 80px budget falls between the 71 and 90 line ends).
    const geometry = { cuts: [33.5, 52.5, 71.5, 90.5, 90.5], height: 160 }
    expect(pickBotItemDetailsCut(geometry, 80)).toBe(72)
  })

  it('cuts a long first close note on a whole line', () => {
    const geometry = { cuts: [36.2, 55.2, 74.2, 93.2, 101.2], height: 180 }
    expect(pickBotItemDetailsCut(geometry, 90.7)).toBe(75)
  })

  it('never shows a first label alone: the label and first line go together, a little past the room', () => {
    // A Done when first block: its label ends at 30 (no cut there); its first line ends at 49.
    const geometry = { cuts: [49, 68, 68], height: 120 }
    expect(pickBotItemDetailsCut(geometry, 40.5)).toBe(49)
  })

  it('cuts a first unit far taller than the room at the room, keeping the Activity reserve', () => {
    // A description led by a 180px image: its first line ends at 200.
    const geometry = { cuts: [200, 219, 219], height: 300 }
    expect(pickBotItemDetailsCut(geometry, 90.7)).toBe(90)
  })

  it('follows content that moved between blocks at the same total height', () => {
    // An edit adds a description line and removes a Done when line: same height, new cuts.
    const before = { cuts: [33, 52, 52, 94, 113, 132, 132], height: 160 }
    const after = { cuts: [33, 52, 71, 71, 113, 132, 132], height: 160 }
    expect(pickBotItemDetailsCut(before, 100)).toBe(94)
    expect(pickBotItemDetailsCut(after, 100)).toBe(71)
  })
})
