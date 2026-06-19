import { describe, expect, it } from 'vitest'
import { getDragEdgeScrollTarget } from './useFileExplorerDragDrop'

describe('getDragEdgeScrollTarget', () => {
  it('returns null away from the drag edge zones', () => {
    expect(
      getDragEdgeScrollTarget({
        scrollTop: 100,
        scrollHeight: 1000,
        clientHeight: 200,
        localY: 100
      })
    ).toBeNull()
  })

  it('scrolls down near the bottom edge', () => {
    const next = getDragEdgeScrollTarget({
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 200,
      localY: 190
    })

    expect(next).toBeGreaterThan(100)
  })

  it('scrolls up near the top edge', () => {
    const next = getDragEdgeScrollTarget({
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 200,
      localY: 10
    })

    expect(next).toBeLessThan(100)
  })

  it('stops at the bottom instead of scheduling a no-op frame forever', () => {
    expect(
      getDragEdgeScrollTarget({
        scrollTop: 800,
        scrollHeight: 1000,
        clientHeight: 200,
        localY: 190
      })
    ).toBeNull()
  })

  it('stops at the top instead of scheduling a no-op frame forever', () => {
    expect(
      getDragEdgeScrollTarget({
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 200,
        localY: 10
      })
    ).toBeNull()
  })
})
