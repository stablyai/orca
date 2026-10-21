import type { DroppedPathConsumer } from '../../../../shared/native-file-drop-preparation'
import { hasWorkspaceFileDragType } from '@/lib/workspace-file-drag'
import { hasNativeFileDragTypes } from '../../../../shared/native-file-drop'
import { OS_FILE_DROP_OWNER_ATTRIBUTE } from '../../../../shared/native-file-drop-preparation'
import type { NativeChatResolvedPathSink } from './use-native-chat-workspace-file-drop'

/** What a drag hovering the chat pane is carrying.
 *  `workspace`: an in-app file drag, attached by the composer's own handlers.
 *  `os`: a Finder/Explorer drag, handled by the pane's OS file owner. */
export type NativeChatPaneDragKind = 'os' | 'workspace'

export type NativeChatPaneDragEvent = {
  currentTarget: { contains: (node: Node | null) => boolean }
  target?: EventTarget | null
  dataTransfer: Pick<DataTransfer, 'types'>
  relatedTarget: EventTarget | null
}

export type CapturedNativeChatDrop = ((paths: string[]) => Promise<void>) & {
  preparationConsumer?: DroppedPathConsumer
}

/** The composer's drop claim, published while a composer is mounted in the pane. */
export type NativeChatPaneDropClaim = {
  destinationKey: string
  captureExternalDrop: () => CapturedNativeChatDrop
  /** A guarded composer refuses the drop, so the pane must not invite one. */
  disabled: boolean
  onDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDropCapture: (
    event: React.DragEvent<HTMLDivElement>,
    attachTo?: NativeChatResolvedPathSink
  ) => void
}

const nestedWorkspaceDropSinks = new WeakMap<
  Element,
  { sink: NativeChatResolvedPathSink; hover?: (active: boolean) => void }
>()

/** A nested drop owner's destination for in-app files, which the composer's claim checks and
 *  routes by the chat's owner, then hands to it. */
export function registerNestedWorkspaceDropSink(
  owner: Element,
  sink: NativeChatResolvedPathSink,
  hover?: (active: boolean) => void
): () => void {
  const registration = { sink, hover }
  nestedWorkspaceDropSinks.set(owner, registration)
  return () => {
    if (nestedWorkspaceDropSinks.get(owner) === registration) {
      nestedWorkspaceDropSinks.delete(owner)
    }
  }
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

/** A drop owner inside the pane (a queued card being edited), which takes drops over it. */
function nestedOwner(event: NativeChatPaneDragEvent): Element | null {
  const owner =
    event.target instanceof Element
      ? event.target.closest(`[${OS_FILE_DROP_OWNER_ATTRIBUTE}]`)
      : null
  return owner !== event.currentTarget ? owner : null
}

function overNestedOwner(event: NativeChatPaneDragEvent): boolean {
  return nestedOwner(event) !== null
}

/** Workspace files keep their provenance-checked lane, landing in a nested owner's sink when
 *  dropped on it; OS files use the native owner, the nearest one. */
export function makeNativeChatPaneFileDropHandlers(host: {
  getClaim: () => NativeChatPaneDropClaim | null
  setDragActive: (active: boolean) => void
}): {
  onDragEnterCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDragLeaveCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDragOverCapture: (event: React.DragEvent<HTMLDivElement>) => void
  onDropCapture: (event: React.DragEvent<HTMLDivElement>) => void
} {
  let hoveredOwner: Element | null = null
  let hover: ((active: boolean) => void) | undefined
  const clearNestedHover = (): void => {
    hover?.(false)
    hoveredOwner = null
    hover = undefined
  }
  const updateNestedHover = (event: NativeChatPaneDragEvent): void => {
    const owner = nestedOwner(event)
    const next = owner ? nestedWorkspaceDropSinks.get(owner)?.hover : undefined
    if (next !== hover) {
      clearNestedHover()
    }
    hoveredOwner = owner
    hover = next
    const kind = nativeChatPaneDragKind(event.dataTransfer)
    const claim = host.getClaim()
    hover?.(kind === 'os' || (kind === 'workspace' && claim !== null && !claim.disabled))
  }
  const showsDropTarget = (event: NativeChatPaneDragEvent): boolean => {
    const kind = nativeChatPaneDragKind(event.dataTransfer)
    if (kind === null || overNestedOwner(event)) {
      return false
    }
    const claim = host.getClaim()
    return claim !== null && !claim.disabled
  }

  return {
    onDragEnterCapture(event) {
      updateNestedHover(event)
      if (showsDropTarget(event)) {
        host.setDragActive(true)
      }
    },
    onDragOverCapture(event) {
      updateNestedHover(event)
      if (showsDropTarget(event)) {
        host.setDragActive(true)
      } else if (overNestedOwner(event)) {
        host.setDragActive(false)
      }
      if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
        host.getClaim()?.onDragOverCapture(event)
      }
    },
    onDragLeaveCapture(event) {
      if (!(event.relatedTarget instanceof Node) || !hoveredOwner?.contains(event.relatedTarget)) {
        clearNestedHover()
      }
      if (nativeChatPaneDragKind(event.dataTransfer) === null || movedWithinDropSurface(event)) {
        return
      }
      host.setDragActive(false)
    },
    onDropCapture(event) {
      clearNestedHover()
      host.setDragActive(false)
      if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
        const owner = nestedOwner(event)
        host
          .getClaim()
          ?.onDropCapture(event, owner ? nestedWorkspaceDropSinks.get(owner)?.sink : undefined)
      }
    }
  }
}
