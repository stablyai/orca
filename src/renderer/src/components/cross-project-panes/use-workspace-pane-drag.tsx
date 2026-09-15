import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getDragPointer } from '../tab-group/tab-drag-pointer'
import { isTabDragData, type TabDragItemData } from '../tab-group/tab-drag-data'
import TabDragPreview from '../tab-bar/TabDragPreview'
import TabGroupDropOverlay from '../tab-group/TabGroupDropOverlay'
import { workspacePaneDropTarget } from './workspace-pane-drop-target'
import type { WorkspaceViewBridge } from '../../../../shared/workspace-view-bridge'

type Preview = ReturnType<typeof workspacePaneDropTarget>
export function useWorkspacePaneDrag() {
  const [drag, setDrag] = useState<TabDragItemData | null>(null)
  const [preview, setPreview] = useState<Preview>(null)
  const [outsideLabel, setOutsideLabel] = useState<string | null>(null)
  const revision = useRef(0)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const clear = () => {
    revision.current++
    setDrag(null)
    setPreview(null)
    setOutsideLabel(null)
  }
  const outside = (point: { x: number; y: number }) =>
    point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight
  const locate = async (point: {
    x: number
    y: number
  }): Promise<Awaited<ReturnType<WorkspaceViewBridge['locateDrop']>>> =>
    window.orcaWorkspaceViews?.locateDrop(point) ?? null
  const move = (event: DragMoveEvent) => {
    const point = getDragPointer(event)
    if (!point) {
      return
    }
    const generation = ++revision.current
    setPreview(workspacePaneDropTarget(point))
    setOutsideLabel(null)
    if (outside(point) && window.orcaWorkspaceViews) {
      setOutsideLabel('Move to New Window')
      void locate(point)
        .then((result) => {
          if (generation === revision.current) {
            setOutsideLabel(result ? `${result.label} in ${result.title}` : 'Move to New Window')
          }
        })
        .catch(() => {
          if (generation === revision.current) {
            setOutsideLabel('Destination unavailable')
          }
        })
    }
  }
  const commit = async (event: DragEndEvent) => {
    const data = event.active.data.current
    const point = getDragPointer(event)
    clear()
    if (!isTabDragData(data) || !data.workspaceViewId || !point) {
      return
    }
    const local = workspacePaneDropTarget(point)
    if (local) {
      useAppStore.getState().moveWorkspaceView(data.workspaceViewId, local.target)
    } else if (outside(point) && window.orcaWorkspaceViews) {
      const bridge = window.orcaWorkspaceViews
      const destination = await locate(point)
      const destinationId = destination?.destinationId ?? (await bridge.createWindow())
      const ok = await bridge.transfer({
        destinationId,
        mode: 'tabs',
        viewIds: [data.workspaceViewId],
        ...(destination ? { target: destination.target } : {})
      })
      if (!ok) {
        toast.error('The transfer could not be confirmed. Your sessions are still running.')
      }
    }
  }
  return {
    sensors,
    onDragStart: (event: DragStartEvent) => {
      if (isTabDragData(event.active.data.current)) {
        setDrag(event.active.data.current)
      }
    },
    onDragMove: move,
    onDragCancel: clear,
    onDragEnd: (event: DragEndEvent) => {
      void commit(event).catch((error) => toast.error(String(error)))
    },
    overlay: createPortal(
      <>
        <DragOverlay dropAnimation={null}>{drag && <TabDragPreview drag={drag} />}</DragOverlay>
        {drag && preview && (
          <div
            className="pointer-events-none fixed z-[70]"
            style={{
              left: preview.rect.left,
              top: preview.rect.top,
              width: preview.rect.width,
              height: preview.rect.height
            }}
          >
            <TabGroupDropOverlay zone={preview.target.zone} />
            <span
              role="status"
              className="absolute left-2 top-2 max-w-80 rounded-sm border border-border bg-popover px-2 py-1 text-xs text-popover-foreground"
            >
              {preview.label}
            </span>
          </div>
        )}
        {drag && outsideLabel && (
          <div
            role="status"
            className="pointer-events-none fixed bottom-4 left-1/2 z-[70] rounded-sm border border-border bg-popover px-2 py-1 text-xs text-popover-foreground"
          >
            {outsideLabel}
          </div>
        )}
      </>,
      document.body
    )
  }
}
