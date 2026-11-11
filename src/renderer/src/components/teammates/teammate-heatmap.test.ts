import { describe, expect, it } from 'vitest'
import { layoutHeatmap } from './teammate-heatmap'

describe('layoutHeatmap', () => {
  it('puts each day on its weekday row and pads the edges', () => {
    // 2026-11-04 is a Wednesday.
    const layout = layoutHeatmap('2026-11-04', [1, 2, 3, 4, 0, 1])
    expect(layout.weeks).toHaveLength(2)
    expect(layout.weeks[0]!.slice(0, 3)).toEqual([null, null, null])
    expect(layout.weeks[0]![3]).toEqual({ date: '2026-11-04', level: 1, index: 0 })
    expect(layout.weeks[1]![0]).toEqual({ date: '2026-11-08', level: 0, index: 4 })
    expect(layout.weeks[1]![1]).toEqual({ date: '2026-11-09', level: 1, index: 5 })
    expect(layout.weeks[1]!.slice(2)).toEqual([null, null, null, null, null])
  })

  it('labels months where they start and drops a cramped first label', () => {
    const levels = Array.from({ length: 182 }, () => 0)
    const layout = layoutHeatmap('2026-05-13', levels)
    expect(layout.weeks).toHaveLength(27)
    expect(layout.months[0]).toMatchObject({ month: 4 })
    expect(layout.months.map((m) => m.month)).toEqual([4, 5, 6, 7, 8, 9, 10])
    const crowded = layoutHeatmap(
      '2026-10-31',
      Array.from({ length: 30 }, () => 0)
    )
    // Oct 31 is a Saturday: October would own a single column, so only November is labeled.
    expect(crowded.months.map((m) => m.month)).toEqual([10])
  })
})
