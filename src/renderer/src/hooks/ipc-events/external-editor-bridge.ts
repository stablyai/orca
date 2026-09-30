import { tagExternalEditorFileWait } from './external-editor-file-wait'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'
import { useAppStore } from '../../store'
import { openLocalFileInFloatingWorkspace } from '@/lib/open-markdown-in-floating-workspace'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { isFloatingWorkspacePanelVisible } from '@/lib/floating-workspace-terminal-actions'
import {
  EXTERNAL_EDITOR_RENDERER_UNAVAILABLE,
  type ExternalEditorRequest
} from '../../../../shared/external-editor'

/** Observe tab lifetime on the desktop that owns the caller's local file. */
export function registerExternalEditorBridge(unsubs: (() => void)[]): void {
  const api = window.api.ui
  if (!api.onExternalEditorRequest || !api.onExternalEditorCancel || !api.respondExternalEditor) {
    return
  }
  const respond = api.respondExternalEditor
  const pending = new Map<string, () => void>()
  /** Caller cancellation releases observation while user edits still belong to the open tab. */
  const cancel = (requestId: string): void => {
    pending.get(requestId)?.()
    pending.delete(requestId)
  }
  /** Enable the floating workspace before acknowledging a request that could otherwise stay hidden. */
  const open = async (request: ExternalEditorRequest): Promise<void> => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let forgetFileWait: (() => void) | undefined
    pending.set(request.requestId, () => {
      cancelled = true
      unsubscribe?.()
      forgetFileWait?.()
    })
    try {
      const store = useAppStore.getState()
      if (!store.settings?.floatingTerminalEnabled) {
        await store.updateSettings({ floatingTerminalEnabled: true })
      }
      if (cancelled) {
        return
      }
      const basename = request.filePath.split(/[\\/]/).pop() || request.filePath
      let fileId = openLocalFileInFloatingWorkspace(
        store.openFile,
        {
          filePath: request.filePath,
          relativePath: basename
        },
        { focusEditor: true }
      )
      // External editors must preserve prompt text, not serialize it through rich Markdown.
      useAppStore.getState().setMarkdownViewMode(fileId, 'source')
      requestAnimationFrame(() => {
        if (!cancelled && !isFloatingWorkspacePanelVisible()) {
          window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
        }
      })
      if (request.wait) {
        forgetFileWait = tagExternalEditorFileWait(fileId, request.requestId)
      }
      respond({ requestId: request.requestId, status: 'opened' })
      if (!request.wait) {
        pending.delete(request.requestId)
        return
      }
      let previousFiles = useAppStore.getState().openFiles
      unsubscribe = useAppStore.subscribe((state) => {
        if (state.openFiles === previousFiles) {
          return
        }
        previousFiles = state.openFiles
        const tracked = state.openFiles.find((file) =>
          file.externalEditorWaitIds?.includes(request.requestId)
        )
        if (tracked) {
          fileId = tracked.id
          return
        }
        unsubscribe?.()
        // A discarded tab can still have an earlier write in flight.
        void Promise.all([
          requestEditorSaveQuiesce({ fileId }),
          requestEditorSaveQuiesce({ externalEditorWaitId: request.requestId })
        ])
          .then(() => {
            if (cancelled) {
              return
            }
            cancel(request.requestId)
            respond({ requestId: request.requestId, status: 'closed' })
          })
          .catch((error: unknown) => {
            if (cancelled) {
              return
            }
            cancel(request.requestId)
            respond({ requestId: request.requestId, status: 'error', error: String(error) })
          })
      })
    } catch (error) {
      cancel(request.requestId)
      respond({
        requestId: request.requestId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  unsubs.push(
    api.onExternalEditorRequest((request) => {
      void open(request)
    }),
    api.onExternalEditorCancel(cancel),
    () => {
      for (const requestId of pending.keys()) {
        cancel(requestId)
        respond({ requestId, status: 'error', error: EXTERNAL_EDITOR_RENDERER_UNAVAILABLE })
      }
    }
  )
}
