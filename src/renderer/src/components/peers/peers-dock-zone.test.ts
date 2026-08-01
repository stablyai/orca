import { describe, expect, it } from 'vitest'
import { dockZoneOverlayRect, resolveDockZone } from './peers-dock-zone'

const paneRect = { x: 100, y: 100, width: 200, height: 100 }

describe('resolveDockZone', () => {
  it('resolves left when the point is near the left edge within the band', () => {
    expect(resolveDockZone({ x: 110, y: 150 }, paneRect)).toBe('left')
  })

  it('resolves right when the point is near the right edge within the band', () => {
    expect(resolveDockZone({ x: 290, y: 150 }, paneRect)).toBe('right')
  })

  it('resolves top when the point is near the top edge within the band', () => {
    expect(resolveDockZone({ x: 200, y: 105 }, paneRect)).toBe('top')
  })

  it('resolves bottom when the point is near the bottom edge within the band', () => {
    expect(resolveDockZone({ x: 200, y: 195 }, paneRect)).toBe('bottom')
  })

  it('returns null in the pane center, outside every edge band', () => {
    expect(resolveDockZone({ x: 200, y: 150 }, paneRect)).toBeNull()
  })

  it('returns null outside the pane bounds', () => {
    expect(resolveDockZone({ x: 50, y: 50 }, paneRect)).toBeNull()
  })

  it('picks the nearer axis at a band boundary just inside 35%', () => {
    // tall pane so the vertical midpoint distance (200) stays outside its own band,
    // isolating the horizontal band check: 35% of width (200) = 70px from the left edge
    const tallPane = { x: 100, y: 0, width: 200, height: 400 }
    expect(resolveDockZone({ x: 169, y: 200 }, tallPane)).toBe('left')
  })

  it('returns null just outside the 35% band', () => {
    const tallPane = { x: 100, y: 0, width: 200, height: 400 }
    expect(resolveDockZone({ x: 171, y: 200 }, tallPane)).toBeNull()
  })

  it('returns null when the dragged leaf is the pane itself', () => {
    expect(
      resolveDockZone({ x: 110, y: 150 }, paneRect, {
        draggedLeafKey: 'host-a:term-1',
        paneLeafKey: 'host-a:term-1'
      })
    ).toBeNull()
  })

  it('still resolves a zone when the dragged leaf differs from the pane', () => {
    expect(
      resolveDockZone({ x: 110, y: 150 }, paneRect, {
        draggedLeafKey: 'host-a:term-1',
        paneLeafKey: 'host-b:term-2'
      })
    ).toBe('left')
  })
})

describe('dockZoneOverlayRect', () => {
  it('highlights the left half', () => {
    expect(dockZoneOverlayRect(paneRect, 'left')).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100
    })
  })

  it('highlights the right half', () => {
    expect(dockZoneOverlayRect(paneRect, 'right')).toEqual({
      x: 200,
      y: 100,
      width: 100,
      height: 100
    })
  })

  it('highlights the top half', () => {
    expect(dockZoneOverlayRect(paneRect, 'top')).toEqual({ x: 100, y: 100, width: 200, height: 50 })
  })

  it('highlights the bottom half', () => {
    expect(dockZoneOverlayRect(paneRect, 'bottom')).toEqual({
      x: 100,
      y: 150,
      width: 200,
      height: 50
    })
  })
})
