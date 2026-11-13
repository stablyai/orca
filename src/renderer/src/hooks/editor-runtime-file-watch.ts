import type { FsChangedPayload } from '../../../shared/file-watch/filesystem-change-event'
import { subscribeRuntimeFileChanges } from '@/runtime/files/watching/runtime-file-watch-client'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { onRuntimeEnvironmentsRetired } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'

export function subscribeEditorRuntimeFileWatch(
  target: EditorExternalWatchTarget & { runtimeEnvironmentId: string },
  onPayload: (payload: FsChangedPayload) => void,
  onError: (error: unknown) => void,
  onFirstReady?: () => void
): () => void {
  let readySeen = false
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
        target: runtimeTargetForOwnerEnvironment(target.runtimeEnvironmentId),
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
      },
      () => {
        if (!isCurrent()) {
          return
        }
        // Resync missed changes only once the host watcher is installed, or writes before install are lost.
        if (resync) {
          onPayload({
            worktreePath: target.worktreePath,
            events: [{ kind: 'overflow', absolutePath: target.worktreePath }],
            resync: true
          })
        }
        if (!readySeen) {
          readySeen = true
          onFirstReady?.()
        }
      }
    )
      .then((stop) => {
        if (!isCurrent()) {
          stop()
          return
        }
        unsubscribe = stop
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
