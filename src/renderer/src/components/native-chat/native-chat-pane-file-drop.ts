import { hasWorkspaceFileDragType } from '@/lib/workspace-file-drag'
import { hasNativeFileDragTypes } from '../../../../shared/native-file-drop'

/** What a drag hovering the chat pane is carrying.
 *  `workspace`: an in-app file drag, attached by the composer's own handlers.
 *  `os`: a Finder/Explorer drag, handled by the pane's OS file owner. */
export type NativeChatPaneDragKind = 'os' | 'workspace'

export type NativeChatPaneDragEvent = {
  currentTarget: { contains: (node: Node | null) => boolean }
  dataTransfer: Pick<DataTransfer, 'types'>
  relatedTarget: EventTarget | null
}

/** The composer's drop claim, published while a composer is mounted in the pane. */
export type NativeChatPaneDropClaim = {
  destinationKey: string
  captureExternalDrop: () => (paths: string[]) => Promise<void>
  /** A guarded composer refuses the drop, so the pane must not invite one. */
  disabled: boolean
  onDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDropCapture: (event: React.DragEvent<HTMLDivElement>) => void
}

export function nativeChatPaneDragKind(
  dataTransfer: Pick<DataTransfer, 'types'> | null
): NativeChatPaneDragKind | null {
  if (!dataTransfer) {
    return null
  }
  if (hasWorkspaceFileDragType(dataTransfer)) {
    return 'workspace'
  }
  return hasNativeFileDragTypes(dataTransfer.types) ? 'os' : null
}

/** True while the cursor only crossed between children of the drop surface —
 *  the leave that follows every child boundary must not end the drag state. */
export function movedWithinDropSurface(event: NativeChatPaneDragEvent): boolean {
  const enteredNode = event.relatedTarget
  return enteredNode instanceof Node && event.currentTarget.contains(enteredNode)
}

/** Workspace files keep their provenance-checked lane; OS files use the native owner. */
export function makeNativeChatPaneFileDropHandlers(host: {
  getClaim: () => NativeChatPaneDropClaim | null
  setDragActive: (active: boolean) => void
}): {
  onDragEnterCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDragLeaveCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDropCapture: (event: React.DragEvent<HTMLDivElement>) => void
} {
  const showsDropTarget = (event: NativeChatPaneDragEvent): boolean => {
    const kind = nativeChatPaneDragKind(event.dataTransfer)
    if (kind === null) {
      return false
    }
    const claim = host.getClaim()
    return claim !== null && !claim.disabled
  }

  return {
    onDragEnterCapture(event) {
      if (showsDropTarget(event)) {
        host.setDragActive(true)
      }
    },
    onDragOverCapture(event) {
      if (showsDropTarget(event)) {
        host.setDragActive(true)
      }
      if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
        host.getClaim()?.onDragOverCapture(event)
      }
    },
    onDragLeaveCapture(event) {
      if (nativeChatPaneDragKind(event.dataTransfer) === null || movedWithinDropSurface(event)) {
        return
      }
      host.setDragActive(false)
    },
    onDropCapture(event) {
      host.setDragActive(false)
      if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
        host.getClaim()?.onDropCapture(event)
      }
    }
  }
}
