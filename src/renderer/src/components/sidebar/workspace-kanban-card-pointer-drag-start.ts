export function shouldStartWorkspaceKanbanCardPointerDrag(
  event: Pick<PointerEvent, 'button' | 'pointerType' | 'shiftKey' | 'metaKey' | 'ctrlKey'>
): boolean {
  if (event.button !== 0 || event.pointerType === 'touch') {
    return false
  }
  // Why: modifier gestures are reserved for selection/context-menu intent.
  // Letting tiny pointer drift start a drag makes Cmd/Ctrl/Shift selection flaky.
  return !event.shiftKey && !event.metaKey && !event.ctrlKey
}

export function shouldIgnoreWorkspaceKanbanCardPointerDown(
  target: EventTarget | null,
  card: HTMLElement
): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  const interactive = target.closest(
    [
      'a',
      'input',
      'button',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[data-workspace-board-column-resize-handle]',
      '[role="menuitem"]'
    ].join(',')
  )
  return interactive !== null && interactive !== card
}
