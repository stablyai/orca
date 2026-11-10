// "Move to this computer" for an Orca Cloud workspace: wake it if asleep, pack and download over
// orcad, create the local workspace through the ordinary create path (reusing the transferred
// branch), apply the uncommitted work and chats, then open it. The cloud workspace is left as is.
// Progress, success and failure render in CloudMoveToComputerDialog (orca-cloud-move-store).
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  getCloudMoveState,
  noteCloudWorkspaceMoved,
  setCloudMoveState,
  type CloudMoveStep
} from '@/lib/orca-cloud/orca-cloud-move-store'
import type {
  CloudTransferPrepared,
  CloudTransferProgressEvent
} from '../../../shared/hosted-sandbox/cloud-transfer-api'

const STEP_OF_PHASE: Partial<Record<CloudTransferProgressEvent['phase'], CloudMoveStep>> = {
  packing: 'packing',
  downloading: 'downloading',
  importing: 'downloading',
  'creating-worktree': 'creating',
  applying: 'applying'
}

/** A move that hasn't settled by now is reported as failed (the pack or download stalled). */
export const MOVE_TIMEOUT_MS = 15 * 60_000

/** The run that holds the one-move-at-a-time guard; a timed-out run releases it. */
let inFlightRun: number | null = null
let runCounter = 0

/** Shared with "Apply changes again": one move or re-apply at a time. */
export function claimMoveRun(): number | null {
  if (inFlightRun !== null) {
    return null
  }
  inFlightRun = ++runCounter
  return inFlightRun
}

export function releaseMoveRun(run: number): void {
  if (inFlightRun === run) {
    inFlightRun = null
  }
}

export async function runOrcaCloudTransferToLocal(
  workspaceId: string,
  name: string,
  options: { archiveAfter?: boolean; onArchive?: (workspaceId: string, name: string) => void } = {}
): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  // One move at a time: a second click (or a retry racing the first) must not start another pack.
  if (!api?.prepareTransferToLocal || inFlightRun !== null) {
    return
  }
  const run = ++runCounter
  inFlightRun = run
  const archiveAfter = options.archiveAfter ?? false
  const startedAt = Date.now()
  let step: CloudMoveStep = 'packing'
  let skipped: CloudMoveStep[] = ['waking']
  let bytes: number | null = null
  let totalBytes: number | null = null
  let timedOut = false
  let localWorktreeId: string | null = null
  let retry: { prepared: CloudTransferPrepared; worktreePath: string } | null = null
  const isHidden = (): boolean => {
    const current = getCloudMoveState()
    return current.stage === 'running' && current.hidden
  }
  const publish = (): void => {
    if (timedOut) {
      return
    }
    const previous = getCloudMoveState()
    setCloudMoveState({
      stage: 'running',
      workspaceId,
      name,
      step,
      skipped,
      startedAt,
      bytes,
      totalBytes,
      archiveAfter,
      hidden: previous.stage === 'running' ? previous.hidden : false
    })
  }
  const timeout = setTimeout(() => {
    // Stop waiting: release the guard so Try again works; this run's late results are ignored
    // except a late success, which still lands as a notice (the workspace really is here).
    timedOut = true
    if (inFlightRun === run) {
      inFlightRun = null
    }
    setCloudMoveState({
      stage: 'failed',
      workspaceId,
      name,
      step,
      timedOut: true,
      localWorktreeId,
      archiveAfter,
      hidden: isHidden()
    })
  }, MOVE_TIMEOUT_MS)
  const live = (): boolean => !timedOut && getCloudMoveState().stage === 'running'
  const dispose = api.onTransferProgress((event) => {
    const next = event.workspaceId === workspaceId ? STEP_OF_PHASE[event.phase] : undefined
    if (!next) {
      return
    }
    step = next
    bytes = event.bytes ?? bytes
    totalBytes = event.totalBytes ?? totalBytes
    publish()
  })
  try {
    publish()
    let prepared = await api.prepareTransferToLocal({ workspaceId })
    if (!prepared.ok && prepared.code === 'asleep') {
      step = 'waking'
      skipped = []
      publish()
      await window.api.ephemeralVm.resumeWorkspace({ workspaceId })
      step = 'packing'
      publish()
      prepared = await api.prepareTransferToLocal({ workspaceId })
    }
    if (!prepared.ok) {
      throw new Error(prepared.message)
    }
    const { transferId, repoId, branch, baseBranch } = prepared.value
    step = 'creating'
    publish()
    const { worktree } = await useAppStore
      .getState()
      .createWorktree(
        repoId,
        branch,
        baseBranch ?? undefined,
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        branch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { branchIntent: 'open-existing-v2' }
      )
    localWorktreeId = worktree.id
    retry = { prepared: prepared.value, worktreePath: worktree.path }
    step = 'applying'
    publish()
    const finished = await api.finishTransferToLocal({ transferId, worktreePath: worktree.path })
    if (!finished.ok) {
      throw new Error(finished.message)
    }
    if (timedOut) {
      noteCloudWorkspaceMoved(workspaceId, Date.now(), worktree.id)
      toast.success(
        translate('orcaCloudMove.notice.lateDone', '{{name}} finished moving to this computer', {
          name
        }),
        {
          duration: 12_000,
          action: {
            label: translate('orcaCloudMove.done.open', 'Open workspace'),
            onClick: () => activateAndRevealWorktree(worktree.id)
          }
        }
      )
      return
    }
    noteCloudWorkspaceMoved(workspaceId, Date.now(), worktree.id)
    const hidden = isHidden()
    // Never archive while something is left to apply: the cloud copy is the other place it lives.
    const archiveNow = archiveAfter && !finished.value.leftoverPatchDir
    setCloudMoveState({
      stage: 'done',
      workspaceId,
      name,
      localWorktreeId: worktree.id,
      prepared: prepared.value,
      finished: finished.value,
      elapsedMs: Date.now() - startedAt,
      archivedAfter: archiveNow,
      hidden
    })
    // Hidden: the user kept working elsewhere; the notice offers Open instead of jumping there.
    if (!hidden) {
      activateAndRevealWorktree(worktree.id)
    }
    if (archiveNow) {
      options.onArchive?.(workspaceId, name)
    }
  } catch (error) {
    // Details go to the log, not the dialog (error tone: plain words, nothing lost, one action).
    console.error('[orca-cloud] move to this computer failed', error)
    if (live()) {
      setCloudMoveState({
        stage: 'failed',
        workspaceId,
        name,
        step,
        timedOut: false,
        localWorktreeId,
        retry,
        archiveAfter,
        hidden: isHidden()
      })
    }
  } finally {
    clearTimeout(timeout)
    if (inFlightRun === run) {
      inFlightRun = null
    }
    dispose()
  }
}

export { offerPendingCloudTransfers, reapplyOrcaCloudTransfer } from './orca-cloud-transfer-reapply'
