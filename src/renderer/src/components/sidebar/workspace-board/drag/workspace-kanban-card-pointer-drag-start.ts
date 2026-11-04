export function shouldStartWorkspaceKanbanCardPointerDrag(
  event: Pick<PointerEvent, 'button' | 'pointerType' | 'shiftKey' | 'metaKey' | 'ctrlKey'>
): boolean {
  if (event.button !== 0 || event.pointerType === 'touch') {
    return false
  }
  // Reserve modifier gestures for selection/context menus so slight drift cannot start a drag.
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
