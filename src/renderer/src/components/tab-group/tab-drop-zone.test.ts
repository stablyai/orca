import { describe, expect, it } from 'vitest'
import {
  paneColumnInteriorRect,
  resolveLeafDropZone,
  resolvePaneColumnEdgeZone,
  TAB_GROUP_TAB_STRIP_HEIGHT_PX
} from './tab-drop-zone'

describe('resolvePaneColumnEdgeZone', () => {
  const panelRect = { left: 0, top: 0, width: 300, height: 200 }

  it('returns right on the outer horizontal band in the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 260, y: 100 })).toBe('right')
  })

  it('returns null in the center band of the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 150, y: 100 })).toBeNull()
  })

  it('does not return up while the pointer is still in the tab strip', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX - 1
      })
    ).toBeNull()
  })

  it('returns up on the top edge of the pane body', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX + 5
      })
    ).toBe('up')
  })
})

describe('resolvePaneColumnEdgeZone: the Level 1 band stays as it was', () => {
  const panel = { left: 0, top: 0, width: 1000, height: 600 }
  const body = { left: 0, top: 32, width: 1000, height: 568 }

  it.each([
    ['left', { x: 199, y: 300 }],
    ['right', { x: 801, y: 300 }],
    ['up', { x: 500, y: 145 }],
    ['down', { x: 500, y: 487 }]
  ] as const)('%s starts at 20%% of the panel width or body height', (zone, point) => {
    expect(resolvePaneColumnEdgeZone(panel, point, { bodyRect: body })).toBe(zone)
  })

  it('leaves the 32 px strip to reordering', () => {
    expect(resolvePaneColumnEdgeZone(panel, { x: 500, y: 31 }, { bodyRect: body })).toBeNull()
  })
})

describe('paneColumnInteriorRect', () => {
  const panel = { left: 100, top: 50, width: 1000, height: 600 }
  const body = { left: 100, top: 82, width: 1000, height: 568 }

  it('is the panel minus the 20% side bands and the 20% top and bottom bands of the body', () => {
    const interior = paneColumnInteriorRect(panel, { bodyRect: body })

    expect(interior?.left).toBeCloseTo(300)
    expect(interior?.width).toBeCloseTo(600)
    expect(interior?.top).toBeCloseTo(82 + 113.6)
    expect(interior?.height).toBeCloseTo(340.8)
  })

  it('derives the body from the strip height when the body rect is unknown', () => {
    const interior = paneColumnInteriorRect(panel)

    expect(interior?.top).toBeCloseTo(50 + TAB_GROUP_TAB_STRIP_HEIGHT_PX + 113.6)
    expect(interior?.height).toBeCloseTo(340.8)
  })

  it('has no interior for a body without height', () => {
    expect(paneColumnInteriorRect(panel, { bodyRect: { ...body, height: 0 } })).toBeNull()
  })

  it('never contains a point that Level 1 would take', () => {
    const interior = paneColumnInteriorRect(panel, { bodyRect: body })
    if (!interior) {
      throw new Error('Missing interior')
    }
    for (let x = panel.left; x <= panel.left + panel.width; x += 25) {
      for (let y = panel.top; y <= panel.top + panel.height; y += 25) {
        const inInterior =
          x >= interior.left &&
          x <= interior.left + interior.width &&
          y >= interior.top &&
          y <= interior.top + interior.height
        if (inInterior) {
          expect(resolvePaneColumnEdgeZone(panel, { x, y }, { bodyRect: body })).toBeNull()
        }
      }
    }
  })
})

describe('resolveLeafDropZone', () => {
  const rect = { left: 100, top: 100, width: 400, height: 200 }

  it('is the center inside the central 25%..75% box on both axes', () => {
    expect(resolveLeafDropZone(rect, { x: 300, y: 200 })).toBe('center')
    expect(resolveLeafDropZone(rect, { x: 201, y: 151 })).toBe('center')
    expect(resolveLeafDropZone(rect, { x: 399, y: 249 })).toBe('center')
  })

  it.each([
    ['left', { x: 110, y: 200 }],
    ['right', { x: 490, y: 200 }],
    ['up', { x: 300, y: 110 }],
    ['down', { x: 300, y: 290 }]
  ] as const)('is %s near that edge', (zone, point) => {
    expect(resolveLeafDropZone(rect, point)).toBe(zone)
  })

  it('picks the nearest edge by share of the rect, so a wide leaf does not favour its sides', () => {
    // 20% from the left (80 px) beats 45% from the top (90 px) only by share, not by pixels.
    expect(resolveLeafDropZone(rect, { x: 180, y: 190 })).toBe('left')
    // 30% from the left but 5% from the top: the top edge is nearer.
    expect(resolveLeafDropZone(rect, { x: 220, y: 110 })).toBe('up')
  })

  it('is null outside the rect', () => {
    expect(resolveLeafDropZone(rect, { x: 50, y: 200 })).toBeNull()
    expect(resolveLeafDropZone(rect, { x: 300, y: 400 })).toBeNull()
  })

  it('reaches all four edges of the interior of a single-leaf tab', () => {
    const panel = { left: 0, top: 0, width: 1000, height: 600 }
    const body = { left: 0, top: 32, width: 1000, height: 568 }
    const interior = paneColumnInteriorRect(panel, { bodyRect: body })
    if (!interior) {
      throw new Error('Missing interior')
    }
    const midX = interior.left + interior.width / 2
    const midY = interior.top + interior.height / 2
    const zones = [
      resolveLeafDropZone(interior, { x: interior.left + 10, y: midY }),
      resolveLeafDropZone(interior, { x: interior.left + interior.width - 10, y: midY }),
      resolveLeafDropZone(interior, { x: midX, y: interior.top + 10 }),
      resolveLeafDropZone(interior, { x: midX, y: interior.top + interior.height - 10 })
    ]

    expect(zones).toEqual(['left', 'right', 'up', 'down'])
  })
})
