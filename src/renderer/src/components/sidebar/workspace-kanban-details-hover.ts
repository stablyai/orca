export function getWorkspaceKanbanDetailsHoverOpenState({
  contextMenuOpen,
  requestedOpen
}: {
  contextMenuOpen: boolean
  requestedOpen: boolean
}): boolean {
  return contextMenuOpen ? false : requestedOpen
}
