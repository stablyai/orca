import { useEffect, useRef, useState, type RefObject } from 'react'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

function getDropTargetSlotId(target: EventTarget | null): string | null {
  return target instanceof Element
    ? (target.closest<HTMLElement>('[data-workspace-multiplexer-slot-id]')?.dataset
        .workspaceMultiplexerSlotId ?? null)
    : null
}

export function useWorkspaceMultiplexerDrag(
  addWorkspace: (workspace: WorkspaceMultiplexerCatalogItem, sourceSlotId?: string | null) => void,
  dropTargetRef: RefObject<HTMLElement | null>
): {
  dropTargetSlotId: string | null | undefined
  clear: () => void
  startWorkspaceDrag: (workspace: WorkspaceMultiplexerCatalogItem) => void
} {
  const draggedWorkspaceRef = useRef<WorkspaceMultiplexerCatalogItem | null>(null)
  const [dropTargetSlotId, setDropTargetSlotId] = useState<string | null | undefined>(undefined)

  const clear = (): void => {
    draggedWorkspaceRef.current = null
    setDropTargetSlotId(undefined)
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
      const targetSlotId = getDropTargetSlotId(event.target)
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      setDropTargetSlotId(targetSlotId)
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!(event.target instanceof Node) || !dropTarget.contains(event.target)) {
        return
      }
      const nextTarget = event.relatedTarget
      if (!(nextTarget instanceof Node) || !dropTarget.contains(nextTarget)) {
        setDropTargetSlotId(undefined)
      }
    }
    const onDrop = (event: DragEvent): void => {
      const workspace = draggedWorkspaceRef.current
      if (!workspace || !(event.target instanceof Node) || !dropTarget.contains(event.target)) {
        return
      }
      event.stopPropagation()
      const targetSlotId = getDropTargetSlotId(event.target)
      event.preventDefault()
      clear()
      addWorkspace(workspace, targetSlotId)
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
    dropTargetSlotId,
    clear,
    startWorkspaceDrag: (workspace) => {
      draggedWorkspaceRef.current = workspace
    }
  }
}
