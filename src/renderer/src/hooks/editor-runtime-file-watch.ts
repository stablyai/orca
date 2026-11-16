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
  onCatchUp: () => void
): () => void {
  let disposed = false
  let attempt = 0
  let unsubscribe: (() => void) | null = null

  const start = (recovering: boolean): void => {
    if (disposed) {
      return
    }
    const currentAttempt = ++attempt
    unsubscribe?.()
    unsubscribe = null
    const isCurrent = (): boolean => !disposed && attempt === currentAttempt
    // Writes between a directory read and the host watcher's install reach neither, so every
    // install re-reads. A recovery also re-reads on acceptance, since install can stay pending.
    let acceptancePending = recovering
    let installPending = true
    const settleInstall = (catchUp: boolean): void => {
      acceptancePending = false
      if (!installPending) {
        return
      }
      installPending = false
      if (catchUp) {
        onCatchUp()
      }
    }
    const fail = (error: unknown): void => {
      if (isCurrent()) {
        settleInstall(recovering)
        onError(error)
      }
    }
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
      fail,
      () => {
        if (isCurrent()) {
          settleInstall(true)
        }
      }
    )
      .then((stop) => {
        if (!isCurrent()) {
          stop()
          return
        }
        unsubscribe = stop
        if (acceptancePending) {
          acceptancePending = false
          onCatchUp()
        }
      })
      .catch(fail)
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
