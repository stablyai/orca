import { toast } from 'sonner'
import type { FileDocument } from '../../../../shared/filesystem-entry-types'
import { revealFloatingWorkspacePanel } from '@/lib/floating-workspace-panel-reveal'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

/**
 * Opens documents the OS shell handed to Orca ("Open With" / double-click) in the
 * floating workspace, which is the one editor surface that needs no project.
 */
async function openOsRequestedDocuments(documents: FileDocument[]): Promise<void> {
  // Why the shape check: this payload crosses the preload boundary, so a stale or mismatched
  // preload can hand back something that is not an array. Reading .length off that throws
  // inside the promise chain rather than failing loudly at the boundary.
  if (!Array.isArray(documents) || documents.length === 0) {
    return
  }
  const store = useAppStore.getState()
  let opened = 0
  for (const document of documents) {
    // Why isolated: selecting several files hands us one batch, and one unopenable file
    // must not cost the user the rest of the selection.
    try {
      openDocumentInFloatingWorkspace(store.openFile, document)
      opened += 1
    } catch (error) {
      reportOsRequestedDocumentFailure(error)
    }
  }
  if (opened === 0) {
    return
  }
  // Why enabled here: the user asked the OS for this file, and the tabs above are already in a
  // surface a disabled floating workspace never renders. Same enable-then-reveal as the
  // Settings "Edit keybindings in Orca" action.
  if (store.settings?.floatingTerminalEnabled !== true) {
    await store.updateSettings({ floatingTerminalEnabled: true })
  }
  // Why deferred a frame: the panel only honors the toggle once the enabled flag has reached React.
  requestAnimationFrame(() => revealFloatingWorkspacePanel(useAppStore.getState()))
}

function reportOsRequestedDocumentFailure(error: unknown): void {
  console.error('Failed to open documents requested by the OS:', error)
  toast.error(translate('osDocumentOpen.failed', 'Failed to open the file.'))
}

export function registerOsMarkdownFileOpenBridge(unsubs: (() => void)[]): void {
  // Startup restoration replaces tabs; keep OS requests in main until it finishes.
  if (!useAppStore.getState().workspaceSessionReady) {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.workspaceSessionReady) {
        unsubscribe()
        registerOsMarkdownFileOpenBridge(unsubs)
      }
    })
    unsubs.push(unsubscribe)
    return
  }
  // Keep the legacy local IPC names; the payload also carries CSV/TSV documents.
  const unsubscribe = window.api.ui.onOpenMarkdownFiles?.((documents) => {
    void openOsRequestedDocuments(documents).catch(reportOsRequestedDocumentFailure)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }

  // Why: a cold-start "Open With" resolves before this listener attaches; drain what main queued.
  const pending = window.api.ui.consumePendingMarkdownFileOpens?.()
  if (pending && typeof pending.then === 'function') {
    void pending.then(openOsRequestedDocuments).catch(reportOsRequestedDocumentFailure)
  }
}
