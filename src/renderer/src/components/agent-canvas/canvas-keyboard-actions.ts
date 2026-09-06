import type { KeyboardEvent } from 'react'
import { isEditableTarget } from '@/lib/editable-target'

export function handleCanvasKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  actions: {
    readOnly: boolean
    selectedId: string | null
    edgeId: string | null
    removeNode: (id: string) => void
    removeEdge: (id: string) => void
    clearSelection: () => void
  }
): void {
  const target = event.target
  if (
    actions.readOnly ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(target instanceof HTMLElement) ||
    isEditableTarget(target) ||
    target.closest('.xterm, button, [role="dialog"]')
  ) {
    return
  }
  if (event.key === 'Escape') {
    actions.clearSelection()
  }
  if (event.key !== 'Delete' && event.key !== 'Backspace') {
    return
  }
  if (!actions.selectedId && !actions.edgeId) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (actions.selectedId) {
    actions.removeNode(actions.selectedId)
  } else if (actions.edgeId) {
    actions.removeEdge(actions.edgeId)
  }
}
