import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

export function subscribeEditorRuntimeFileWatch(
  target: EditorExternalWatchTarget & { runtimeEnvironmentId: string },
  onPayload: (payload: FsChangedPayload) => void,
  onError: (error: unknown) => void
): () => void {
  let disposed = false
  let attempt = 0
  let unsubscribe: (() => void) | null = null

  const start = (resync: boolean): void => {
    if (disposed) {
      return
    }
    const currentAttempt = ++attempt
    unsubscribe?.()
    unsubscribe = null
    const isCurrent = (): boolean => !disposed && attempt === currentAttempt
    void subscribeRuntimeFileChanges(
      {
        settings: { activeRuntimeEnvironmentId: target.runtimeEnvironmentId },
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      },
      (payload) => {
        if (isCurrent()) {
          onPayload(payload)
        }
      },
      (error) => {
        if (isCurrent()) {
          onError(error)
        }
      }
    )
      .then((stop) => {
        if (!isCurrent()) {
          stop()
          return
        }
        unsubscribe = stop
        // A restored stream cannot replay file changes missed while contact was lost.
        if (resync) {
          onPayload({
            worktreePath: target.worktreePath,
            events: [{ kind: 'overflow', absolutePath: target.worktreePath }]
          })
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          onError(error)
        }
      })
  }
  const stopContact = subscribeRuntimeHostContactRegained(target.runtimeEnvironmentId, () =>
    start(true)
  )
  const stopRetirement = onRuntimeEnvironmentsRetired((ids) => {
    if (ids.includes(target.runtimeEnvironmentId)) {
      dispose()
    }
  })
  function dispose(): void {
    if (disposed) {
      return
    }
    disposed = true
    attempt += 1
    unsubscribe?.()
    unsubscribe = null
    stopContact()
    stopRetirement()
  }
  start(false)
  return dispose
}
