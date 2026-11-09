// "Move to this computer" for an Orca Cloud workspace: wake it if asleep, pack and download over
// orcad, create the local workspace through the ordinary create path (reusing the transferred
// branch), apply the uncommitted work and chats, then open it. The cloud workspace is left as is.
// Progress, success and failure render in CloudMoveToComputerDialog (orca-cloud-move-store).
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  getCloudMoveState,
  noteCloudWorkspaceMoved,
  setCloudMoveState,
  type CloudMoveStep
} from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudTransferProgressEvent } from '../../../shared/hosted-sandbox/cloud-transfer-api'

const STEP_OF_PHASE: Partial<Record<CloudTransferProgressEvent['phase'], CloudMoveStep>> = {
  packing: 'packing',
  downloading: 'downloading',
  importing: 'downloading',
  'creating-worktree': 'creating',
  applying: 'applying'
}

export async function runOrcaCloudTransferToLocal(
  workspaceId: string,
  name: string
): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  if (!api?.prepareTransferToLocal) {
    return
  }
  const startedAt = Date.now()
  let step: CloudMoveStep = 'packing'
  let skipped: CloudMoveStep[] = ['waking']
  let bytes: number | null = null
  let totalBytes: number | null = null
  const publish = (): void =>
    setCloudMoveState({
      stage: 'running',
      workspaceId,
      name,
      step,
      skipped,
      startedAt,
      bytes,
      totalBytes
    })
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
    step = 'applying'
    publish()
    const finished = await api.finishTransferToLocal({ transferId, worktreePath: worktree.path })
    if (!finished.ok) {
      throw new Error(finished.message)
    }
    noteCloudWorkspaceMoved(workspaceId, Date.now())
    setCloudMoveState({
      stage: 'done',
      workspaceId,
      name,
      localWorktreeId: worktree.id,
      prepared: prepared.value,
      finished: finished.value,
      elapsedMs: Date.now() - startedAt
    })
    activateAndRevealWorktree(worktree.id)
  } catch (error) {
    // Details go to the log, not the dialog (error tone: plain words, nothing lost, one action).
    console.error('[orca-cloud] move to this computer failed', error)
    if (getCloudMoveState().stage === 'running') {
      setCloudMoveState({ stage: 'failed', workspaceId, name, step })
    }
  } finally {
    dispose()
  }
}
