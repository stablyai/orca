// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  collectPaneRectsInTreeOrder,
  findAdjacentPaneId,
  type SpatialPaneRect
} from './pane-spatial-focus'

function rect(id: number, x: number, y: number, width: number, height: number): SpatialPaneRect {
  return { id, x, y, width, height }
}

function stubPaneRect(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () => DOMRect.fromRect({ x, y, width, height })
}

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

  it('lets the pane before a misaligned divider own its band (columns)', () => {
    // [col(A,B) | col(C,D)] with 10px dividers; D's top sits in the band between A and B.
    const panes = [
      rect(1, 0, 0, 100, 100),
      rect(2, 0, 110, 100, 190),
      rect(3, 110, 0, 100, 95),
      rect(4, 110, 105, 100, 195)
    ]
    expect(findAdjacentPaneId(4, panes, 'left', 10)).toBe(1)
    // Aligned control: a source at B's top still picks B, not A.
    const aligned = [...panes.slice(0, 2), rect(3, 110, 0, 100, 100), rect(4, 110, 110, 100, 190)]
    expect(findAdjacentPaneId(4, aligned, 'left', 10)).toBe(2)
  })

  it('lets the pane before a misaligned divider own its band (rows)', () => {
    // [row(A|B) / row(C|D)] with 10px dividers; D's left sits in the band between A and B.
    const panes = [
      rect(1, 0, 0, 100, 100),
      rect(2, 110, 0, 190, 100),
      rect(3, 0, 110, 95, 100),
      rect(4, 105, 110, 195, 100)
    ]
    expect(findAdjacentPaneId(4, panes, 'up', 10)).toBe(1)
    const aligned = [...panes.slice(0, 2), rect(3, 0, 110, 100, 100), rect(4, 110, 110, 190, 100)]
    expect(findAdjacentPaneId(4, aligned, 'up', 10)).toBe(2)
  })

  it('keeps aligned panes aligned when zoom renders the divider a fraction short', () => {
    // A 10px divider measured 9.998779px at uiZoomLevel 0.5.
    const gap = 9.998779
    const panes = [
      rect(1, 0, 0, 100, 100),
      rect(2, 0, 100 + gap, 100, 100),
      rect(3, 100 + gap, 0, 100, 100),
      rect(4, 100 + gap, 100 + gap, 100, 100)
    ]
    expect(findAdjacentPaneId(4, panes, 'left', 10)).toBe(2)
  })

  // Each source's top-left sits 0.25px before the later pane's start (10px dividers).
  it.each([
    {
      direction: 'left',
      source: 4,
      expected: 2,
      panes: [
        rect(1, 0, 0, 100, 100),
        rect(2, 0, 110, 100, 190),
        rect(3, 110, 0, 100, 99.75),
        rect(4, 110, 109.75, 100, 190.25)
      ]
    },
    {
      direction: 'right',
      source: 2,
      expected: 4,
      panes: [
        rect(1, 0, 0, 100, 99.75),
        rect(2, 0, 109.75, 100, 190.25),
        rect(3, 110, 0, 100, 100),
        rect(4, 110, 110, 100, 190)
      ]
    },
    {
      direction: 'up',
      source: 4,
      expected: 2,
      panes: [
        rect(1, 0, 0, 100, 100),
        rect(2, 110, 0, 190, 100),
        rect(3, 0, 110, 99.75, 100),
        rect(4, 109.75, 110, 190.25, 100)
      ]
    },
    {
      direction: 'down',
      source: 2,
      expected: 4,
      panes: [
        rect(1, 0, 0, 99.75, 100),
        rect(2, 109.75, 0, 190.25, 100),
        rect(3, 0, 110, 100, 100),
        rect(4, 110, 110, 190, 100)
      ]
    }
  ] as const)(
    'picks the later pane from just before its start ($direction)',
    ({ direction, source, expected, panes }) => {
      expect(findAdjacentPaneId(source, panes, direction, 10)).toBe(expected)
    }
  )

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

    stubPaneRect(paneA, 0, 0, 100, 200)
    stubPaneRect(paneB, 110, 0, 100, 95)
    stubPaneRect(paneC, 110, 105, 100, 95)

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
