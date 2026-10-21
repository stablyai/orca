export function keyboardEventBelongsToScope(event: KeyboardEvent, scope: HTMLElement): boolean {
  const target = event.target
  if (target instanceof Element && target.closest('[data-terminal-image-attachments]')) {
    return false
  }
  if (target instanceof Node && scope.contains(target)) {
    return true
  }
  const activeElement = scope.ownerDocument.activeElement
  return activeElement instanceof Node && scope.contains(activeElement)
}
