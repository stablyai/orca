import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import {
  disarmWorkspaceFileDrag,
  useWorkspaceFileDragActive
} from '@/lib/workspace-file-drag-activity'
import {
  getWorkspaceFileDragRejectionMessage,
  hasWorkspaceFileDragTypes,
  readWorkspaceFileDragPaths
} from '@/lib/workspace-file-drag'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getEditorFileDropOperationContext } from '@/hooks/useGlobalFileDrop'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { captureTabGroupPanelGeometrySnapshot } from './tab-group-panel-split-target'
import {
  buildWorkspaceFilePaneDropZones,
  type DropZoneRect,
  type WorkspaceFilePaneDropZone
} from './workspace-file-pane-drop-zones'
import { openWorkspaceFilePathsInSplit } from './workspace-file-pane-drop'

function toOverlayStyle(rect: DropZoneRect): CSSProperties {
  return { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
}

function isSameZone(
  a: WorkspaceFilePaneDropZone | null,
  b: WorkspaceFilePaneDropZone | null
): boolean {
  return a?.groupId === b?.groupId && a?.splitDirection === b?.splitDirection
}

export default function WorkspaceFileSplitDropLayer({
  worktreeId,
  enabled
}: {
  worktreeId: string
  enabled: boolean
}): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const [zones, setZones] = useState<WorkspaceFilePaneDropZone[]>([])
  const [hoveredZone, setHoveredZone] = useState<WorkspaceFilePaneDropZone | null>(null)
  const isDragActive = useWorkspaceFileDragActive() && enabled

  useLayoutEffect(() => {
    if (!isDragActive) {
      setZones([])
      setHoveredZone(null)
      return
    }
    const layerRect = layerRef.current?.getBoundingClientRect()
    if (!layerRect) {
      return
    }
    // Why: pane geometry cannot change mid-drag, so one snapshot beats measuring per dragover.
    const geometry = captureTabGroupPanelGeometrySnapshot(worktreeId)
    setZones(
      buildWorkspaceFilePaneDropZones(
        geometry.entries.map((entry) => ({ bodyRect: entry.bodyRect, groupId: entry.groupId })),
        layerRect
      )
    )
  }, [isDragActive, worktreeId])

  const handleDrop = useCallback(
    (zone: WorkspaceFilePaneDropZone, dataTransfer: DataTransfer) => {
      // Why: read the payload before anything can re-render this handler's own
      // drop target out from under the gesture.
      const pathsResult = readWorkspaceFileDragPaths(dataTransfer)
      // Why: this handler stops propagation, so the window-level drop cleanup
      // never runs — disarm here instead of leaving live bands over the panes.
      disarmWorkspaceFileDrag()
      setHoveredZone(null)
      if (pathsResult.status === 'rejected') {
        toast.error(getWorkspaceFileDragRejectionMessage(pathsResult.reason))
        return
      }
      if (pathsResult.paths.length === 0) {
        return
      }

      const store = useAppStore.getState()
      const worktreePath = store.getKnownWorktreeById(worktreeId)?.path
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
      let fileContext: ReturnType<typeof getEditorFileDropOperationContext>
      try {
        fileContext = getEditorFileDropOperationContext(
          store,
          worktreeId,
          worktreePath,
          getConnectionId(worktreeId) ?? undefined
        )
      } catch {
        toast.error(
          translate(
            'auto.components.tab.group.WorkspaceFileSplitDropLayer.ownerUnresolved',
            "Couldn't verify which host owns this workspace. Try again after it reconnects."
          )
        )
        return
      }

      void openWorkspaceFilePathsInSplit(
        {
          createEmptySplitGroup: store.createEmptySplitGroup,
          isDirectory: async (filePath) => {
            try {
              return (await statRuntimePath(fileContext, filePath)).isDirectory
            } catch {
              // Why: an unreadable path can't be proven openable; let the editor report the real error.
              return false
            }
          },
          openFile: store.openFile,
          setActiveTabType: store.setActiveTabType
        },
        {
          paths: pathsResult.paths,
          runtimeEnvironmentId,
          sourceGroupId: zone.groupId,
          splitDirection: zone.splitDirection,
          worktreeId,
          worktreePath
        }
      ).catch(() => {
        toast.error(
          translate(
            'auto.components.tab.group.WorkspaceFileSplitDropLayer.openFailed',
            'Could not open the dropped files in a new pane.'
          )
        )
      })
    },
    [worktreeId]
  )

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      data-workspace-file-split-drop-layer="true"
      data-worktree-id={worktreeId}
      className="absolute inset-0 z-[10000] pointer-events-none"
    >
      {zones.map((zone) => (
        <div
          key={`${zone.groupId}:${zone.splitDirection}`}
          className="absolute pointer-events-auto"
          style={toOverlayStyle(zone.hitRect)}
          onDragOver={(event) => {
            if (!hasWorkspaceFileDragTypes(event.dataTransfer)) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'copy'
            setHoveredZone((current) => (isSameZone(current, zone) ? current : zone))
          }}
          onDragLeave={() => {
            setHoveredZone((current) => (isSameZone(current, zone) ? null : current))
          }}
          onDrop={(event) => {
            if (!hasWorkspaceFileDragTypes(event.dataTransfer)) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            handleDrop(zone, event.dataTransfer)
          }}
        />
      ))}
      {hoveredZone ? (
        <div
          className="tab-drop-overlay absolute"
          style={toOverlayStyle(hoveredZone.previewRect)}
        />
      ) : null}
    </div>
  )
}
