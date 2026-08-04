import { describe, expect, it } from 'vitest'
import { getRichMarkdownTableControlLayout } from './rich-markdown-table-control-layout'

describe('rich markdown table control layout', () => {
  it('places controls around the hovered row, column, and table edges', () => {
    expect(
      getRichMarkdownTableControlLayout({
        cell: { left: 150, right: 250, top: 100, bottom: 140 },
        row: { left: 50, right: 350, top: 100, bottom: 140 },
        table: { left: 50, right: 350, top: 60, bottom: 220 },
        container: { clientHeight: 400, clientWidth: 500, scrollLeft: 0, scrollTop: 0 }
      })
    ).toEqual({
      rowMenu: { left: 32, top: 108 },
      columnMenu: { left: 188, top: 42 },
      addColumn: { left: 354, top: 60 },
      addRow: { left: 50, top: 224 }
    })
  })

  it('keeps every control reachable in a narrow, scrolled editor', () => {
    const layout = getRichMarkdownTableControlLayout({
      cell: { left: 20, right: 180, top: 60, bottom: 100 },
      row: { left: 20, right: 620, top: 60, bottom: 100 },
      table: { left: 20, right: 620, top: 20, bottom: 800 },
      container: { clientHeight: 180, clientWidth: 120, scrollLeft: 90, scrollTop: 300 }
    })

    for (const point of Object.values(layout)) {
      expect(point.left).toBeGreaterThanOrEqual(94)
      expect(point.left).toBeLessThanOrEqual(182)
      expect(point.top).toBeGreaterThanOrEqual(304)
      expect(point.top).toBeLessThanOrEqual(452)
    }
  })
})
