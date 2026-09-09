/**
 * Pushing an external edit into a running live preview.
 *
 * `officecli watch` does not detect external edits, and an agent editing the document is exactly
 * the external-edit case — so without this a "live" preview would sit on the render it started
 * with. The push is `office.watchRefresh`, which re-POSTs the document to the watch server's
 * switch endpoint; the server re-renders and tells connected pages to reload themselves.
 *
 * This lives outside the preview pane on purpose. Going live converts the page, so the pane that
 * started the session is unmounted by the time the first edit lands.
 */
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import type { OfficeHostOwner } from '../../../shared/office-host-owner'

/** Coalesces the burst of events a single save produces into one re-render. */
const REFRESH_DEBOUNCE_MS = 400

type LiveRefreshSubscription = { dispose: () => void }

function touchesDocument(payload: FsChangedPayload, documentPath: string): boolean {
  const target = normalizeRuntimePathForComparison(documentPath)
  return payload.events.some(
    (event) =>
      event.kind === 'overflow' ||
      normalizeRuntimePathForComparison(event.absolutePath) === target ||
      (event.oldAbsolutePath !== undefined &&
        normalizeRuntimePathForComparison(event.oldAbsolutePath) === target)
  )
}

/**
 * Watches one document and refreshes its live preview when it changes.
 *
 * Best-effort: a workspace whose changes cannot be watched still shows a live preview, it just
 * stops updating itself. That degrades quietly rather than failing the session, because the
 * reader can still reload the page.
 */
export function subscribeOfficeLiveRefresh(params: {
  owner: OfficeHostOwner
  filePath: string
  worktreeId: string
  worktreePath: string | null
}): LiveRefreshSubscription {
  let disposed = false
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const requestRefresh = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      if (!disposed) {
        void window.api.office
          .watchRefresh({ owner: params.owner, path: params.filePath })
          .catch(() => undefined)
      }
    }, REFRESH_DEBOUNCE_MS)
  }

  const onPayload = (payload: FsChangedPayload): void => {
    if (!disposed && touchesDocument(payload, params.filePath)) {
      requestRefresh()
    }
  }

  if (params.owner.kind === 'runtime' && params.worktreePath) {
    // Remote runtime watch events never enter this desktop's fs:changed bus.
    void subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: params.owner.environmentId },
        worktreeId: params.worktreeId,
        worktreePath: params.worktreePath,
        connectionId: undefined
      },
      onPayload
    )
      .then((dispose) => {
        if (disposed) {
          dispose()
          return
        }
        unsubscribe = dispose
      })
      .catch(() => undefined)
  } else {
    if (params.worktreePath) {
      void window.api.fs
        .watchWorktree({
          worktreePath: params.worktreePath,
          connectionId: params.owner.kind === 'ssh' ? params.owner.connectionId : undefined
        })
        .catch(() => undefined)
    }
    unsubscribe = window.api.fs.onFsChanged(onPayload)
  }

  return {
    dispose: () => {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      unsubscribe?.()
      // Deliberately not unwatching the worktree: the editor's watch is refcounted by the same
      // provider, and tearing it down here would blind whatever else is watching this workspace.
    }
  }
}
