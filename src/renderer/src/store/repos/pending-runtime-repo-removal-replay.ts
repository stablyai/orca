import { toast } from 'sonner'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { ERROR_TOAST_DURATION } from './repo-state'
import { isRuntimeEnvironmentRegistered } from './runtime-environment-registration'
import {
  dropPendingRuntimeRepoRemovalsForEnvironment,
  listPendingRuntimeRepoRemovals,
  replayPendingRuntimeRepoRemovals
} from './pending-runtime-repo-removals'

// Main publishes status only on change, so readiness is remembered for records written later.
const readyEnvironments = new Set<string>()
const replayingEnvironments = new Set<string>()
// A ready snapshot that lands mid-replay must not be lost if that replay then fails as unreachable.
const readyDuringReplay = new Set<string>()

/** Replays owed removals for a ready server; a no-op while one replay for it is still running. */
export function replayPendingRuntimeRepoRemovalsIfReady(environmentId: string): void {
  if (
    !readyEnvironments.has(environmentId) ||
    replayingEnvironments.has(environmentId) ||
    listPendingRuntimeRepoRemovals(environmentId).length === 0
  ) {
    return
  }
  replayingEnvironments.add(environmentId)
  const target = { kind: 'environment', environmentId } as const
  void replayPendingRuntimeRepoRemovals(
    environmentId,
    (repoId) => callRuntimeRpc(target, 'repo.rm', { repo: repoId }, { timeoutMs: 15_000 }),
    (_repoId, error) => {
      toast.error(
        translate(
          'auto.store.slices.repos.pendingRemovalRefused',
          'The server kept a project you removed while it was offline'
        ),
        { description: readIpcErrorMessage(error) ?? String(error), duration: ERROR_TOAST_DURATION }
      )
      // The fence hid the server's row; lifting it needs a fresh listing to show the project again.
      // Lazy: the store imports this module through repo removal.
      void import('@/store')
        .then(({ useAppStore }) =>
          useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
        )
        .catch((error) =>
          console.warn('[repos] catalog refresh after a refused removal failed', error)
        )
    }
  )
    .then((outcome) => {
      replayingEnvironments.delete(environmentId)
      const reconnected = readyDuringReplay.delete(environmentId)
      // Records written during this run were skipped by the in-flight guard; take them now.
      if (outcome === 'settled' || reconnected) {
        replayPendingRuntimeRepoRemovalsIfReady(environmentId)
      }
    })
    .catch((error) => {
      replayingEnvironments.delete(environmentId)
      readyDuringReplay.delete(environmentId)
      console.warn('[repos] replaying pending project removals failed', error)
    })
}

/** Records seeded at startup may postdate the ready snapshot that already arrived. */
export function replayPendingRuntimeRepoRemovalsForReadyServers(): void {
  for (const environmentId of readyEnvironments) {
    replayPendingRuntimeRepoRemovalsIfReady(environmentId)
  }
}

export function observeRuntimeHostStatusForPendingRemovals(
  snapshot: RuntimeHostStatusSnapshot
): void {
  const { environmentId } = snapshot
  if (snapshot.retired === true) {
    readyEnvironments.delete(environmentId)
    // Disconnects and re-pairs retire status owners too; only a forgotten server drops its records.
    void isRuntimeEnvironmentRegistered(environmentId).then((registered) => {
      if (!registered) {
        dropPendingRuntimeRepoRemovalsForEnvironment(environmentId)
      }
    })
    return
  }
  if (snapshot.transport === 'ready' && snapshot.verification === 'verified') {
    if (!readyEnvironments.has(environmentId) && replayingEnvironments.has(environmentId)) {
      readyDuringReplay.add(environmentId)
    }
    readyEnvironments.add(environmentId)
    replayPendingRuntimeRepoRemovalsIfReady(environmentId)
  } else {
    readyEnvironments.delete(environmentId)
  }
}

export function resetPendingRuntimeRepoRemovalReplayForTests(): void {
  readyEnvironments.clear()
  replayingEnvironments.clear()
  readyDuringReplay.clear()
}
