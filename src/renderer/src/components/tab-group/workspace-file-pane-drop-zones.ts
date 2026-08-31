import { PANE_COLUMN_EDGE_RATIO } from './tab-drop-zone'
import type { TabSplitDirection } from '../../store/slices/tabs'

export type DropZoneRect = { height: number; left: number; top: number; width: number }

export type PaneBodyGeometry = { bodyRect: DropZoneRect; groupId: string }

export type WorkspaceFilePaneDropZone = {
  groupId: string
  /** Hit area that arms the split. */
  hitRect: DropZoneRect
  /** Half of the pane the dropped file would take. */
  previewRect: DropZoneRect
  splitDirection: TabSplitDirection
}

/**
 * Edge bands for every visible pane, in coordinates local to the drop layer.
 * The middle of each pane stays uncovered so terminal panes keep receiving the
 * path-into-PTY drop they already handle.
 */
export function buildWorkspaceFilePaneDropZones(
  panes: readonly PaneBodyGeometry[],
  layerOrigin: { left: number; top: number }
): WorkspaceFilePaneDropZone[] {
  const zones: WorkspaceFilePaneDropZone[] = []
  for (const { bodyRect, groupId } of panes) {
    const left = bodyRect.left - layerOrigin.left
    const top = bodyRect.top - layerOrigin.top
    const { height, width } = bodyRect
    if (width <= 0 || height <= 0) {
      continue
    }
    const edgeWidth = width * PANE_COLUMN_EDGE_RATIO
    const edgeHeight = height * PANE_COLUMN_EDGE_RATIO

    zones.push(
      {
        groupId,
        hitRect: { height, left, top, width: edgeWidth },
        previewRect: { height, left, top, width: width / 2 },
        splitDirection: 'left'
      },
      {
        groupId,
        hitRect: { height, left: left + width - edgeWidth, top, width: edgeWidth },
        previewRect: { height, left: left + width / 2, top, width: width / 2 },
        splitDirection: 'right'
      }
    )

    const verticalBandWidth = width - edgeWidth * 2
    zones.push(
      {
        groupId,
        hitRect: { height: edgeHeight, left: left + edgeWidth, top, width: verticalBandWidth },
        previewRect: { height: height / 2, left, top, width },
        splitDirection: 'up'
      },
      {
        groupId,
        hitRect: {
          height: edgeHeight,
          left: left + edgeWidth,
          top: top + height - edgeHeight,
          width: verticalBandWidth
        },
        previewRect: { height: height / 2, left, top: top + height / 2, width },
        splitDirection: 'down'
      }
    )
  }
  return zones
}
