import { useEffect, useRef, useState, type RefObject } from 'react'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'
import { resolvePaneColumnEdgeZone } from '../tab-group/tab-drop-zone'
import type { TabSplitDirection } from '@/store/slices/tabs'

function getDropTarget(event: DragEvent) {
  const element =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-workspace-multiplexer-slot-id]')
      : null
  const panelRect = element?.getBoundingClientRect()
  return {
    slotId: element?.dataset.workspaceMultiplexerSlotId ?? null,
    preview: panelRect
      ? {
          panelRect,
          zone:
            resolvePaneColumnEdgeZone(panelRect, { x: event.clientX, y: event.clientY }) ??
            ('right' as const)
        }
      : null
  }
}

export function useWorkspaceMultiplexerDrag(
  addWorkspace: (
    workspace: WorkspaceMultiplexerCatalogItem,
    sourceSlotId?: string | null,
    direction?: TabSplitDirection
  ) => void,
  dropTargetRef: RefObject<HTMLElement | null>
): {
  dropTargetSlotId: string | null | undefined
  preview: ReturnType<typeof getDropTarget>['preview']
  clear: () => void
  startWorkspaceDrag: (workspace: WorkspaceMultiplexerCatalogItem) => void
} {
  const draggedWorkspaceRef = useRef<WorkspaceMultiplexerCatalogItem | null>(null)
  const [target, setTarget] = useState<ReturnType<typeof getDropTarget>>()

  const clear = (): void => {
    draggedWorkspaceRef.current = null
    setTarget(undefined)
  }

  useEffect(() => {
    const dropTarget = dropTargetRef.current
    if (!dropTarget) {
      return
    }
    const onDragOver = (event: DragEvent): void => {
      if (
        !draggedWorkspaceRef.current ||
        !(event.target instanceof Node) ||
        !dropTarget.contains(event.target)
      ) {
        return
      }
      event.stopPropagation()
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      setTarget(getDropTarget(event))
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!(event.target instanceof Node) || !dropTarget.contains(event.target)) {
        return
      }
      const nextTarget = event.relatedTarget
      if (!(nextTarget instanceof Node) || !dropTarget.contains(nextTarget)) {
        setTarget(undefined)
      }
    }
    const onDrop = (event: DragEvent): void => {
      const workspace = draggedWorkspaceRef.current
      if (!workspace || !(event.target instanceof Node) || !dropTarget.contains(event.target)) {
        return
      }
      event.stopPropagation()
      const target = getDropTarget(event)
      event.preventDefault()
      clear()
      addWorkspace(workspace, target.slotId, target.preview?.zone)
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [addWorkspace, dropTargetRef])

  return {
    dropTargetSlotId: target?.slotId,
    preview: target?.preview ?? null,
    clear,
    startWorkspaceDrag: (workspace) => {
      draggedWorkspaceRef.current = workspace
    }
  }
}
