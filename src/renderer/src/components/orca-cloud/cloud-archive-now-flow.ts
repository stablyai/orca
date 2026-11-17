// ARCHIVE-NOW: Archive on the workspace in front shows the archived page at once (no toast). The
// page offers Undo for the undo window, shows the archive hook running and asks about its failure
// inline, and a failed archive reverts the page and leaves an inline notice.
import {
  getOptimisticArchive,
  setCloudArchiveFailure,
  setOptimisticArchive
} from '@/lib/orca-cloud/optimistic-cloud-archive'
import { refreshCloudWorkspaceStatus } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { registerQueuedCloudArchive } from '@/lib/orca-cloud/pending-cloud-archive'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedArchiveHookFailure } from '../../../../shared/hosted-sandbox/hosted-archive-hook-wire'

export type ArchiveNowDeps = {
  undoMs: number
  hookNeedsWake: boolean
  localCopy?: { hasLocalCopy: boolean; editedHere: number }
  /** Runs the hook (no toast); null when it passed or there was none. */
  runHook: (wake: boolean) => Promise<HostedArchiveHookFailure | null>
  /** Sleep, then the control-plane archive; `beforeSleep` false keeps the workspace. */
  commit: (beforeSleep: () => Promise<boolean>) => Promise<CloudWorkspaceResult<null>>
  reportFailure: () => boolean
  /** The failure in words (the same mapping as the toasts: sign in again, plan, unreachable). */
  describeFailure: (result: Extract<CloudWorkspaceResult<null>, { ok: false }>) => string
  /** Still the workspace in front: false shows the failure as a toast instead of on its page. */
  inFront: () => boolean
  toastFailure: (result: Extract<CloudWorkspaceResult<null>, { ok: false }>) => void
  now?: () => number
}

/** Resolves true once archived, false when undone, declined or failed (the page has said why). */
export function runArchiveNow(workspaceId: string, deps: ArchiveNowDeps): Promise<boolean> {
  const startedAt = (deps.now ?? Date.now)()
  let skipHook = false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const undo = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unregister()
      setOptimisticArchive(workspaceId, null)
      resolve(false)
    }
    const showUndo = (): void =>
      setOptimisticArchive(workspaceId, {
        startedAt,
        phase: 'undo',
        undo,
        ...(deps.localCopy?.hasLocalCopy ? { localCopy: deps.localCopy } : {}),
        ...(deps.hookNeedsWake && !skipHook
          ? {
              skipHook: () => {
                skipHook = true
                showUndo()
              }
            }
          : {})
      })
    const unregister = registerQueuedCloudArchive(workspaceId, undo)
    showUndo()
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      unregister()
      void commit().then(resolve)
    }, deps.undoMs)
  })

  async function commit(): Promise<boolean> {
    const beforeSleep = async (): Promise<boolean> => {
      if (skipHook) {
        console.warn('[orca-cloud] archive hook skipped by the user (asleep)', { workspaceId })
        return true
      }
      const wake = deps.hookNeedsWake
      setOptimisticArchive(workspaceId, {
        startedAt,
        phase: 'archiving',
        step: wake ? 'hook-waking' : 'hook'
      })
      const failure = await deps.runHook(wake)
      if (!failure) {
        return true
      }
      const archive = await new Promise<boolean>((decide) =>
        setOptimisticArchive(workspaceId, { startedAt, phase: 'hook-failed', failure, decide })
      )
      if (archive) {
        console.warn('[orca-cloud] archive hook failure waived; archiving anyway', { workspaceId })
      }
      return archive
    }
    const saving = (): void =>
      setOptimisticArchive(workspaceId, { startedAt, phase: 'archiving', step: 'saving' })
    saving()
    const result = await deps.commit(async () => {
      const go = await beforeSleep()
      if (go) {
        saving()
      }
      return go
    })
    if (!getOptimisticArchive(workspaceId)) {
      return result.ok
    }
    if (result.ok) {
      // Keep the page until the status read says archived, so it never flashes back.
      await refreshCloudWorkspaceStatus(workspaceId).catch(() => undefined)
      setOptimisticArchive(workspaceId, null)
      return true
    }
    if (deps.reportFailure() && !deps.inFront()) {
      setOptimisticArchive(workspaceId, null)
      deps.toastFailure(result)
    } else if (deps.reportFailure()) {
      setCloudArchiveFailure(workspaceId, deps.describeFailure(result))
    } else {
      setOptimisticArchive(workspaceId, null)
    }
    return false
  }
}
