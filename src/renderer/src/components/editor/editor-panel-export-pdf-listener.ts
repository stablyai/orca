import { exportActiveMarkdownToPdf } from './export-active-markdown'

// Why: the "File -> Export as PDF..." menu IPC fans out to every EditorPanel
// instance, and split-pane layouts mount N panels concurrently. This ref-counted
// singleton keeps exactly one renderer subscription alive while any panel exists.
let exportPdfListenerOwners = 0
let exportPdfListenerUnsubscribe: (() => void) | null = null

export function acquireExportPdfListener(): () => void {
  exportPdfListenerOwners += 1
  if (exportPdfListenerOwners === 1) {
    exportPdfListenerUnsubscribe = window.api.ui.onExportPdfRequested(() => {
      void exportActiveMarkdownToPdf()
    })
  }
  return () => {
    exportPdfListenerOwners -= 1
    if (exportPdfListenerOwners === 0 && exportPdfListenerUnsubscribe) {
      exportPdfListenerUnsubscribe()
      exportPdfListenerUnsubscribe = null
    }
  }
}
