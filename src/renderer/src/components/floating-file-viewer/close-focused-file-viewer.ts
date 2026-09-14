import { useFloatingFileViewers } from './floating-file-viewer-state'

export function closeFocusedFileViewer(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const id = document.activeElement
    ?.closest('[data-floating-file-viewer]')
    ?.getAttribute('data-floating-file-viewer')
  const state = useFloatingFileViewers.getState()
  if (!id || state.hidden || !state.viewers.some((viewer) => viewer.id === id)) {
    return false
  }
  state.close(id)
  return true
}
