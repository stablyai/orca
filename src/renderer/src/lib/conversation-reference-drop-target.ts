export function conversationReferenceDropTarget(point: {
  x: number
  y: number
}): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-conversation-reference-drop]'
  )) {
    // Why: a hidden retained pane can keep its box while measuring, stacked under the shown one.
    if (element.closest('[inert], [hidden]')) {
      continue
    }
    const rect = element.getBoundingClientRect()
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return element
    }
  }
  return null
}

export function forwardConversationReferenceDrop(event: DragEvent): boolean {
  const composer = conversationReferenceDropTarget({ x: event.clientX, y: event.clientY })
  if (!composer) {
    return false
  }
  if (!(event.target instanceof Node) || !composer.contains(event.target)) {
    event.preventDefault()
    event.stopPropagation()
    composer.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: event.dataTransfer,
        clientX: event.clientX,
        clientY: event.clientY
      })
    )
  }
  return true
}
