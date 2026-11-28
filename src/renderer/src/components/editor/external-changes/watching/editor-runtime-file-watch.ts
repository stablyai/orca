import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import { subscribeRuntimeFileChanges } from '@/runtime/files/watching/runtime-file-watch-client'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { onRuntimeEnvironmentsRetired } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { isRuntimeEnvironmentPairingChangedError } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'

// A reconnect can refuse the re-watch mid transport swap; without a retry Source Control waits for its 60 s poll.
const PAIRING_REFUSAL_RETRY_DELAYS_MS = [250, 1_000, 4_000]

export function subscribeEditorRuntimeFileWatch(
  target: EditorExternalWatchTarget & { runtimeEnvironmentId: string },
  onPayload: (payload: FsChangedPayload) => void,
  onError: (error: unknown) => void,
  onCatchUp: () => void
): () => void {
  let disposed = false
  let attempt = 0
  let unsubscribe: (() => void) | null = null
  let pairingRetries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const clearRetry = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  const retryAfterPairingRefusal = (error: unknown, failedAttempt: number): boolean => {
    if (retryTimer) {
      return true
    }
    const delayMs = PAIRING_REFUSAL_RETRY_DELAYS_MS[pairingRetries]
    if (delayMs === undefined || !isRuntimeEnvironmentPairingChangedError(error)) {
      return false
    }
    pairingRetries += 1
    // No catalog read per watch: main re-reads the current pairing on every subscribe.
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!disposed && attempt === failedAttempt) {
        start(true)
      }
    }, delayMs)
    return true
  }

  const start = (recovering: boolean): void => {
    if (disposed) {
      return
    }
    clearRetry()
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
      if (!isCurrent() || retryAfterPairingRefusal(error, currentAttempt)) {
        return
      }
      settleInstall(recovering)
      onError(error)
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
          pairingRetries = 0
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
  const stopContact = subscribeRuntimeHostContactRegained(target.runtimeEnvironmentId, () => {
    pairingRetries = 0
    start(true)
  })
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
    clearRetry()
    unsubscribe?.()
    unsubscribe = null
    stopContact()
    stopRetirement()
  }
  start(false)
  return dispose
}
