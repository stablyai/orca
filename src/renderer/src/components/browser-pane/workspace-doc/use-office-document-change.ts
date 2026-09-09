/**
 * "The document changed on disk" for one open preview.
 *
 * Rides the existing `files.watch` family rather than polling: the same stream the editor and the
 * file explorer already use, subscribed for this worktree and filtered to one path. That is what
 * makes an agent's edit turn the refresh control `updated` a second or two later, on any host.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { normalizeRuntimePathForComparison } from '../../../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../../../shared/filesystem-entry-types'
import type { OfficeHostOwner } from '../../../../../shared/office-host-owner'

export type OfficeDocumentChange = {
  /** True once a change has been reported and not yet consumed by a re-render. */
  changed: boolean
  /** Called when a re-render has taken the new content on board. */
  consume: () => void
}

/**
 * An `overflow` event means the watcher lost track of individual paths, so it has to be treated as
 * "this document may have changed". Reporting nothing there is how a stale preview looks fresh.
 */
function payloadTouchesDocument(payload: FsChangedPayload, documentPath: string): boolean {
  const target = normalizeRuntimePathForComparison(documentPath)
  return payload.events.some(
    (event) =>
      event.kind === 'overflow' ||
      normalizeRuntimePathForComparison(event.absolutePath) === target ||
      (event.oldAbsolutePath !== undefined &&
        normalizeRuntimePathForComparison(event.oldAbsolutePath) === target)
  )
}

export function useOfficeDocumentChange({
  worktreeId,
  filePath,
  owner
}: {
  worktreeId: string
  filePath: string
  owner: OfficeHostOwner | null
}): OfficeDocumentChange {
  const [changed, setChanged] = useState(false)
  const worktreePath = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  const documentPathRef = useRef(filePath)
  documentPathRef.current = filePath

  // Why the ref rather than a dependency: re-subscribing on every reported change would drop
  // events in the gap, which is the defect `useEditorExternalWatch` diffs its targets to avoid.
  const ownerKey = owner ? JSON.stringify(owner) : null

  useEffect(() => {
    setChanged(false)
  }, [filePath])

  useEffect(() => {
    if (!owner || !worktreePath) {
      return
    }
    let disposed = false
    let unsubscribe: (() => void) | null = null
    const onPayload = (payload: FsChangedPayload): void => {
      if (!disposed && payloadTouchesDocument(payload, documentPathRef.current)) {
        setChanged(true)
      }
    }

    if (owner.kind === 'runtime') {
      // Remote runtime watch events never enter this desktop's fs:changed bus.
      void subscribeRuntimeFileChanges(
        {
          settings: { activeRuntimeEnvironmentId: owner.environmentId },
          worktreeId,
          worktreePath,
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
        .catch(() => {
          // A preview that cannot watch still renders; it just never reports itself stale, and the
          // manual re-render stays available. Nothing here is worth a toast.
        })
      return () => {
        disposed = true
        unsubscribe?.()
      }
    }

    const connectionId = owner.kind === 'ssh' ? owner.connectionId : undefined
    void window.api.fs.watchWorktree({ worktreePath, connectionId }).catch(() => {})
    unsubscribe = window.api.fs.onFsChanged(onPayload)
    return () => {
      disposed = true
      unsubscribe?.()
      // Deliberately not unwatching the worktree: the editor's own watch is refcounted by the same
      // provider, and tearing it down here would blind whatever else is watching this workspace.
    }
  }, [ownerKey, owner, worktreeId, worktreePath])

  const consume = useCallback(() => setChanged(false), [])
  return { changed, consume }
}
