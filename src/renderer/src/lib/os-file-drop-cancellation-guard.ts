import { hasNativeFileDragTypes } from '../../../shared/native-file-drop'
import { WORKSPACE_FILE_DRAG_SOURCE_MIME, WORKSPACE_FILE_PATHS_MIME } from './workspace-file-drag'

let disposeInstalledGuard: (() => void) | null = null

export function hasOsFileDragTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  if (!hasNativeFileDragTypes(types)) {
    return false
  }
  const values = Array.from(types ?? [])
  return (
    !values.includes(WORKSPACE_FILE_PATHS_MIME) && !values.includes(WORKSPACE_FILE_DRAG_SOURCE_MIME)
  )
}

/** Cancels unclaimed OS file drops before the browser can navigate to them. */
export function installOsFileDropCancellationGuard(): () => void {
  if (disposeInstalledGuard) {
    return disposeInstalledGuard
  }

  const claimedBeforeGuard = new WeakSet<DragEvent>()
  const onCapture = (event: DragEvent): void => {
    if (!hasOsFileDragTypes(event.dataTransfer?.types)) {
      return
    }
    if (event.defaultPrevented) {
      claimedBeforeGuard.add(event)
    }
    event.preventDefault()
  }
  const onUnclaimed = (event: DragEvent): void => {
    if (!hasOsFileDragTypes(event.dataTransfer?.types) || claimedBeforeGuard.has(event)) {
      return
    }
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none'
    }
  }

  document.addEventListener('dragover', onCapture, true)
  document.addEventListener('drop', onCapture, true)
  document.addEventListener('dragover', onUnclaimed)
  document.addEventListener('drop', onUnclaimed)

  const dispose = (): void => {
    document.removeEventListener('dragover', onCapture, true)
    document.removeEventListener('drop', onCapture, true)
    document.removeEventListener('dragover', onUnclaimed)
    document.removeEventListener('drop', onUnclaimed)
    if (disposeInstalledGuard === dispose) {
      disposeInstalledGuard = null
    }
  }
  disposeInstalledGuard = dispose
  return dispose
}
