import { describe, expect, it } from 'vitest'
import { getDragEdgeScrollTarget } from './file-explorer-drag-edge-scroll'

describe('getDragEdgeScrollTarget', () => {
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
