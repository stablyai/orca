export const PDF_ZOOM_COMMAND_EVENT = 'orca:pdf-zoom-command'

export type PdfZoomDirection = 'in' | 'out' | 'reset'

export type PdfZoomTargetState = {
  activeFileId: string | null
  activeGroupIdByWorktree: Record<string, string | undefined>
  activeWorktreeId: string | null
  openFiles: { id: string; filePath: string }[]
}

export function isActivePdfZoomTarget(
  container: HTMLElement | null,
  filePath: string,
  state: PdfZoomTargetState
): boolean {
  if (!container || container.clientHeight === 0) {
    return false
  }

  const activeFile = state.openFiles.find((file) => file.id === state.activeFileId)
  if (activeFile?.filePath !== filePath) {
    return false
  }

  const groupBody = container.closest<HTMLElement>('[data-tab-group-body-id]')
  if (groupBody) {
    const worktreeId = groupBody.dataset.worktreeId
    return Boolean(
      worktreeId &&
      worktreeId === state.activeWorktreeId &&
      groupBody.dataset.tabGroupBodyId === state.activeGroupIdByWorktree[worktreeId]
    )
  }

  return true
}

export function dispatchPdfZoomCommand(direction: PdfZoomDirection): boolean {
  const event = new CustomEvent<PdfZoomDirection>(PDF_ZOOM_COMMAND_EVENT, {
    cancelable: true,
    detail: direction
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function addPdfZoomCommandListener(
  callback: (direction: PdfZoomDirection) => boolean
): () => void {
  const listener = (event: Event): void => {
    const command = event as CustomEvent<PdfZoomDirection>
    if (callback(command.detail)) {
      command.preventDefault()
    }
  }
  window.addEventListener(PDF_ZOOM_COMMAND_EVENT, listener)
  return () => window.removeEventListener(PDF_ZOOM_COMMAND_EVENT, listener)
}
