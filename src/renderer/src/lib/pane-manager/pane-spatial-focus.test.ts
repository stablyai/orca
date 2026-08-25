// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  applySpatialPaneFocusKey,
  collectPaneRectsInTreeOrder,
  findAdjacentPaneId,
  findSpatiallyAdjacentPaneId,
  isSpatialFocusDirection,
  type SpatialPaneRect
} from './pane-spatial-focus'

function rect(id: number, x: number, y: number, width: number, height: number): SpatialPaneRect {
  return { id, x, y, width, height }
}

describe('isSpatialFocusDirection', () => {
  it('accepts the four Windows Terminal directions only', () => {
    expect(isSpatialFocusDirection('left')).toBe(true)
    expect(isSpatialFocusDirection('right')).toBe(true)
    expect(isSpatialFocusDirection('up')).toBe(true)
    expect(isSpatialFocusDirection('down')).toBe(true)
    expect(isSpatialFocusDirection('next')).toBe(false)
    expect(isSpatialFocusDirection('previous')).toBe(false)
  })
})

describe('findAdjacentPaneId', () => {
  it('selects the top-right leaf from a tall left pane (#8263 one-to-two)', () => {
    // ┌─────┬─────┐
    // │     │  B  │
    // │  A  ├─────┤
    // │     │  C  │
    // └─────┴─────┘
    const panes = [rect(1, 0, 0, 100, 200), rect(2, 100, 0, 100, 100), rect(3, 100, 100, 100, 100)]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBe(2)
    expect(findAdjacentPaneId(2, panes, 'left', 0)).toBe(1)
    expect(findAdjacentPaneId(3, panes, 'left', 0)).toBe(1)
    expect(findAdjacentPaneId(2, panes, 'down', 0)).toBe(3)
    expect(findAdjacentPaneId(3, panes, 'up', 0)).toBe(2)
  })

  it('keeps focus when no pane shares the requested edge', () => {
    const panes = [rect(1, 0, 0, 100, 200), rect(2, 100, 0, 100, 100), rect(3, 100, 100, 100, 100)]

    expect(findAdjacentPaneId(1, panes, 'left', 0)).toBeNull()
    expect(findAdjacentPaneId(1, panes, 'up', 0)).toBeNull()
    expect(findAdjacentPaneId(1, panes, 'down', 0)).toBeNull()
    expect(findAdjacentPaneId(2, panes, 'right', 0)).toBeNull()
    expect(findAdjacentPaneId(2, panes, 'up', 0)).toBeNull()
    expect(findAdjacentPaneId(3, panes, 'right', 0)).toBeNull()
    expect(findAdjacentPaneId(3, panes, 'down', 0)).toBeNull()
  })

  it('does not wrap around the layout', () => {
    const panes = [rect(1, 0, 0, 100, 100), rect(2, 100, 0, 100, 100)]

    expect(findAdjacentPaneId(1, panes, 'left', 0)).toBeNull()
    expect(findAdjacentPaneId(2, panes, 'right', 0)).toBeNull()
  })

  it('uses the top-left anchor so uneven stacked neighbors stay deterministic', () => {
    // A is tall; B is a short top-right strip; C takes the remaining right side.
    const panes = [rect(1, 0, 0, 80, 200), rect(2, 80, 0, 120, 40), rect(3, 80, 40, 120, 160)]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBe(2)
    expect(findAdjacentPaneId(3, panes, 'left', 0)).toBe(1)
    expect(findAdjacentPaneId(2, panes, 'down', 0)).toBe(3)
  })

  it('navigates a 2x2 nested split by shared borders, not creation order', () => {
    const panes = [
      rect(1, 0, 0, 100, 100),
      rect(2, 100, 0, 100, 100),
      rect(3, 0, 100, 100, 100),
      rect(4, 100, 100, 100, 100)
    ]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBe(2)
    expect(findAdjacentPaneId(1, panes, 'down', 0)).toBe(3)
    expect(findAdjacentPaneId(2, panes, 'left', 0)).toBe(1)
    expect(findAdjacentPaneId(2, panes, 'down', 0)).toBe(4)
    expect(findAdjacentPaneId(3, panes, 'up', 0)).toBe(1)
    expect(findAdjacentPaneId(3, panes, 'right', 0)).toBe(4)
    expect(findAdjacentPaneId(4, panes, 'left', 0)).toBe(3)
    expect(findAdjacentPaneId(4, panes, 'up', 0)).toBe(2)
  })

  it('does not jump over an intervening pane to a farther neighbor', () => {
    const panes = [rect(1, 0, 0, 100, 100), rect(2, 100, 0, 100, 100), rect(3, 200, 0, 100, 100)]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBe(2)
    expect(findAdjacentPaneId(3, panes, 'left', 0)).toBe(2)
  })

  it('treats a divider-sized gap as a shared border', () => {
    const panes = [rect(1, 0, 0, 100, 200), rect(2, 110, 0, 100, 100), rect(3, 110, 110, 100, 90)]

    expect(findAdjacentPaneId(1, panes, 'right', 12)).toBe(2)
    expect(findAdjacentPaneId(2, panes, 'left', 12)).toBe(1)
    expect(findAdjacentPaneId(3, panes, 'left', 12)).toBe(1)
    expect(findAdjacentPaneId(2, panes, 'down', 12)).toBe(3)
  })

  it('uses the first-most tree-order leaf when two candidates are adjacent', () => {
    const overlappingRight = [
      rect(1, 0, 0, 100, 100),
      rect(9, 100, 0, 80, 100),
      rect(2, 100, 0, 80, 100)
    ]

    expect(findAdjacentPaneId(1, overlappingRight, 'right', 0)).toBe(9)
  })

  it('ignores zero-size panes so an expanded layout does not steal focus', () => {
    const panes = [rect(1, 0, 0, 200, 200), rect(2, 0, 0, 0, 0), rect(3, 200, 0, 0, 200)]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBeNull()
  })

  it('returns null for a missing or zero-size source', () => {
    expect(findAdjacentPaneId(99, [rect(1, 0, 0, 100, 100)], 'right', 0)).toBeNull()
    expect(
      findAdjacentPaneId(1, [rect(1, 0, 0, 0, 100), rect(2, 0, 0, 100, 100)], 'right', 0)
    ).toBeNull()
  })

  it('uses the half-closed perpendicular span so a shared seam belongs to the later pane', () => {
    const panes = [rect(1, 0, 0, 100, 100), rect(2, 100, 0, 100, 50), rect(3, 100, 50, 100, 50)]

    expect(findAdjacentPaneId(1, panes, 'right', 0)).toBe(2)
    // Source top is exactly C's top: [50, 100) includes 50, so C wins over B.
    expect(
      findAdjacentPaneId(3, [rect(3, 100, 50, 100, 50), rect(2, 100, 0, 100, 50)], 'up', 0)
    ).toBe(2)
  })
})

describe('collectPaneRectsInTreeOrder', () => {
  it('walks first-child then second-child, skipping dividers', () => {
    const root = document.createElement('div')
    root.className = 'pane-split is-vertical'
    const paneA = document.createElement('div')
    paneA.className = 'pane'
    const divider = document.createElement('div')
    divider.className = 'pane-divider is-vertical'
    const inner = document.createElement('div')
    inner.className = 'pane-split is-horizontal'
    const paneB = document.createElement('div')
    paneB.className = 'pane'
    const innerDivider = document.createElement('div')
    innerDivider.className = 'pane-divider is-horizontal'
    const paneC = document.createElement('div')
    paneC.className = 'pane'
    inner.append(paneB, innerDivider, paneC)
    root.append(paneA, divider, inner)
    document.body.append(root)

    paneA.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 200 }) as DOMRect
    paneB.getBoundingClientRect = () => ({ x: 110, y: 0, width: 100, height: 95 }) as DOMRect
    paneC.getBoundingClientRect = () => ({ x: 110, y: 105, width: 100, height: 95 }) as DOMRect

    // Creation order C, A, B — tree order must still be A, B, C.
    const ordered = collectPaneRectsInTreeOrder([
      { id: 3, container: paneC },
      { id: 1, container: paneA },
      { id: 2, container: paneB }
    ])

    expect(ordered.map((pane) => pane.id)).toEqual([1, 2, 3])
    root.remove()
  })
})

describe('findSpatiallyAdjacentPaneId', () => {
  it('resolves the #8263 layout from DOM tree order plus divider gap', () => {
    const root = document.createElement('div')
    root.className = 'pane-split is-vertical'
    const paneA = document.createElement('div')
    paneA.className = 'pane'
    const divider = document.createElement('div')
    divider.className = 'pane-divider is-vertical'
    const inner = document.createElement('div')
    inner.className = 'pane-split is-horizontal'
    const paneB = document.createElement('div')
    paneB.className = 'pane'
    const innerDivider = document.createElement('div')
    innerDivider.className = 'pane-divider is-horizontal'
    const paneC = document.createElement('div')
    paneC.className = 'pane'
    inner.append(paneB, innerDivider, paneC)
    root.append(paneA, divider, inner)
    document.body.append(root)

    paneA.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 200 }) as DOMRect
    paneB.getBoundingClientRect = () => ({ x: 110, y: 0, width: 100, height: 95 }) as DOMRect
    paneC.getBoundingClientRect = () => ({ x: 110, y: 105, width: 100, height: 95 }) as DOMRect

    const panes = [
      { id: 1, container: paneA },
      { id: 2, container: paneB },
      { id: 3, container: paneC }
    ]

    expect(findSpatiallyAdjacentPaneId(1, panes, 'right')).toBe(2)
    expect(findSpatiallyAdjacentPaneId(2, panes, 'left')).toBe(1)
    expect(findSpatiallyAdjacentPaneId(3, panes, 'left')).toBe(1)
    expect(findSpatiallyAdjacentPaneId(2, panes, 'down')).toBe(3)
    expect(findSpatiallyAdjacentPaneId(1, panes, 'left')).toBeNull()
    root.remove()
  })
})

describe('applySpatialPaneFocusKey', () => {
  it('claims the chord only when a neighbor exists', () => {
    const root = document.createElement('div')
    root.className = 'pane-split is-vertical'
    const paneA = document.createElement('div')
    paneA.className = 'pane'
    const divider = document.createElement('div')
    divider.className = 'pane-divider is-vertical'
    const paneB = document.createElement('div')
    paneB.className = 'pane'
    root.append(paneA, divider, paneB)
    document.body.append(root)

    paneA.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 100 }) as DOMRect
    paneB.getBoundingClientRect = () => ({ x: 110, y: 0, width: 100, height: 100 }) as DOMRect

    const setActivePane = vi.fn()
    const event = {
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn()
    }
    const manager = {
      getPanes: () => [
        { id: 1, container: paneA },
        { id: 2, container: paneB }
      ],
      getActivePane: () => ({ id: 1 }),
      setActivePane
    }

    expect(applySpatialPaneFocusKey(event, manager, 'right')).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(setActivePane).toHaveBeenCalledWith(2, { focus: true })

    event.preventDefault.mockClear()
    event.stopImmediatePropagation.mockClear()
    setActivePane.mockClear()

    expect(applySpatialPaneFocusKey(event, manager, 'left')).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(setActivePane).not.toHaveBeenCalled()
    root.remove()
  })
})
