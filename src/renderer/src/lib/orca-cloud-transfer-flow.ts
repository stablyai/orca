// "Move to this computer" for an Orca Cloud workspace: wake it if asleep, pack and download over
// orcad, create the local workspace through the ordinary create path (reusing the transferred
// branch), apply the uncommitted work and chats, then open it. The cloud workspace is left as is.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { CloudTransferProgressEvent } from '../../../shared/hosted-sandbox/cloud-transfer-api'

const PHASE_COPY: Record<CloudTransferProgressEvent['phase'], [string, string]> = {
  packing: ['auto.lib.orcaCloudTransfer.packing', 'Packing the cloud workspace…'],
  downloading: ['auto.lib.orcaCloudTransfer.downloading', 'Downloading…'],
  importing: ['auto.lib.orcaCloudTransfer.importing', 'Bringing the branch over…'],
  'creating-worktree': ['auto.lib.orcaCloudTransfer.creating', 'Creating the local workspace…'],
  applying: ['auto.lib.orcaCloudTransfer.applying', 'Applying uncommitted changes and chats…'],
  done: ['auto.lib.orcaCloudTransfer.done', 'Moved to this computer'],
  failed: ['auto.lib.orcaCloudTransfer.failed', 'Could not move the workspace']
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

export async function runOrcaCloudTransferToLocal(workspaceId: string): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  if (!api?.prepareTransferToLocal) {
    return
  }
  const toastId = `orca-cloud-transfer-${workspaceId}`
  const show = (phase: CloudTransferProgressEvent['phase'], detail?: string): void => {
    const [key, fallback] = PHASE_COPY[phase]
    toast.loading(translate(key, fallback), {
      id: toastId,
      description: detail,
      duration: Infinity
    })
  }
  const dispose = api.onTransferProgress((event) => {
    if (event.workspaceId !== workspaceId || event.phase === 'failed' || event.phase === 'done') {
      return
    }
    show(
      event.phase,
      event.phase === 'downloading' && event.bytes ? formatBytes(event.bytes) : undefined
    )
  })
  try {
    show('packing')
    let prepared = await api.prepareTransferToLocal({ workspaceId })
    if (!prepared.ok && prepared.code === 'asleep') {
      toast.loading(translate('auto.lib.orcaCloudTransfer.waking', 'Waking the workspace…'), {
        id: toastId,
        duration: Infinity
      })
      await window.api.ephemeralVm.resumeWorkspace({ workspaceId })
      prepared = await api.prepareTransferToLocal({ workspaceId })
    }
    if (!prepared.ok) {
      throw new Error(prepared.message)
    }
    const { transferId, repoId, branch, baseBranch } = prepared.value
    show('creating-worktree')
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
    const finished = await api.finishTransferToLocal({ transferId, worktreePath: worktree.path })
    if (!finished.ok) {
      throw new Error(finished.message)
    }
    const { claudeSessions, codexSessions, leftoverPatchDir } = finished.value
    const chats = claudeSessions + codexSessions
    toast.success(translate('auto.lib.orcaCloudTransfer.done', 'Moved to this computer'), {
      id: toastId,
      duration: 8_000,
      description: leftoverPatchDir
        ? translate(
            'auto.lib.orcaCloudTransfer.leftovers',
            'Some changes did not apply cleanly; they were saved to {{dir}}.',
            { dir: leftoverPatchDir }
          )
        : translate(
            'auto.lib.orcaCloudTransfer.summary',
            'Branch {{branch}} with your uncommitted changes and agent chats ({{count}}). The cloud workspace is unchanged.',
            { branch, count: chats }
          )
    })
    activateAndRevealWorktree(worktree.id)
  } catch (error) {
    toast.error(translate('auto.lib.orcaCloudTransfer.failed', 'Could not move the workspace'), {
      id: toastId,
      duration: 12_000,
      description: error instanceof Error ? error.message : String(error)
    })
  } finally {
    dispose()
  }
}
