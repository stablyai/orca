import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceFilePaneDropZones,
  type WorkspaceFilePaneDropZone
} from './workspace-file-pane-drop-zones'
import type { TabSplitDirection } from '../../store/slices/tabs'

const PANE = { bodyRect: { height: 200, left: 100, top: 50, width: 400 }, groupId: 'a' }
const ORIGIN = { left: 100, top: 50 }

function zoneFor(direction: TabSplitDirection): WorkspaceFilePaneDropZone {
  const zone = buildWorkspaceFilePaneDropZones([PANE], ORIGIN).find(
    (candidate) => candidate.splitDirection === direction
  )
  if (!zone) {
    throw new Error(`missing ${direction} zone`)
  }
  return zone
}

describe('buildWorkspaceFilePaneDropZones', () => {
  it('emits one band per split direction', () => {
    expect(buildWorkspaceFilePaneDropZones([PANE], ORIGIN).map((z) => z.splitDirection)).toEqual([
      'left',
      'right',
      'up',
      'down'
    ])
  })

  it('translates pane geometry into layer-local coordinates', () => {
    expect(zoneFor('left').hitRect).toEqual({ height: 200, left: 0, top: 0, width: 80 })
  })

  it('leaves the middle of the pane uncovered so terminal drops still land', () => {
    const centerX = 200
    const centerY = 100
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      const rect = zoneFor(direction).hitRect
      const insideX = centerX >= rect.left && centerX <= rect.left + rect.width
      const insideY = centerY >= rect.top && centerY <= rect.top + rect.height
      expect(insideX && insideY).toBe(false)
    }
  })

  it('anchors the down band to the bottom edge', () => {
    expect(zoneFor('down').hitRect).toEqual({ height: 40, left: 80, top: 160, width: 240 })
  })

  it('previews the half the dropped file would take', () => {
    expect(zoneFor('right').previewRect).toEqual({ height: 200, left: 200, top: 0, width: 200 })
    expect(zoneFor('up').previewRect).toEqual({ height: 100, left: 0, top: 0, width: 400 })
  })

  it('drops panes with no area', () => {
    const collapsed = { bodyRect: { height: 0, left: 0, top: 0, width: 400 }, groupId: 'a' }
    expect(buildWorkspaceFilePaneDropZones([collapsed], { left: 0, top: 0 })).toEqual([])
  })
})
