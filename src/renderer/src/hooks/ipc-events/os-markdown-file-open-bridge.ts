import { toast } from 'sonner'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { isFloatingWorkspacePanelVisible } from '@/lib/floating-workspace-terminal-actions'
import { openMarkdownDocumentInFloatingWorkspace } from '@/lib/open-markdown-in-floating-workspace'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

/**
 * Opens markdown files the OS shell handed to Orca ("Open With" / double-click) in the
 * floating workspace, which is the one editor surface that needs no project.
 */
async function openOsRequestedMarkdownFiles(documents: MarkdownDocument[]): Promise<void> {
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
      openMarkdownDocumentInFloatingWorkspace(store.openFile, document)
      opened += 1
    } catch (error) {
      reportOsRequestedMarkdownFailure(error)
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
  requestAnimationFrame(() => {
    if (!isFloatingWorkspacePanelVisible()) {
      window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
    }
  })
}

function reportOsRequestedMarkdownFailure(error: unknown): void {
  console.error('Failed to open markdown files requested by the OS:', error)
  toast.error(
    translate(
      'auto.hooks.ipc.events.os.markdown.file.open.bridge.1e9a1a63c4',
      'Failed to open the Markdown file.'
    )
  )
}

export function registerOsMarkdownFileOpenBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.ui.onOpenMarkdownFiles?.((documents) => {
    void openOsRequestedMarkdownFiles(documents).catch(reportOsRequestedMarkdownFailure)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }

  // Why: a cold-start "Open With" resolves before this listener attaches; drain what main queued.
  const pending = window.api.ui.consumePendingMarkdownFileOpens?.()
  if (pending && typeof pending.then === 'function') {
    void pending.then(openOsRequestedMarkdownFiles).catch(reportOsRequestedMarkdownFailure)
  }
}
