import { hasOsFileDragTypes } from '@/lib/os-file-drop-cancellation-guard'

/**
 * Lets an offscreen page take OS file drops itself. A <webview> gets them in its own process; this
 * element sits in Orca's document, so it claims them before any Orca drop owner sees them.
 */
export function bindOffscreenPageFileDrop(
  host: HTMLElement,
  drop: (point: { x: number; y: number }, files: File[]) => void
): void {
  host.addEventListener('dragover', (event) => {
    if (!hasOsFileDragTypes(event.dataTransfer?.types)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  })
  host.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!hasOsFileDragTypes(event.dataTransfer?.types) || files.length === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const box = host.getBoundingClientRect()
    drop({ x: event.clientX - box.left, y: event.clientY - box.top }, files)
  })
}
