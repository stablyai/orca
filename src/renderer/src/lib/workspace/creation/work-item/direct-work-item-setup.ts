import {
  pickApprovedSetupHashes,
  type ApprovedSetupHashes
} from '../../../../../../shared/worktree/creation/approved-setup-hashes'
import { useAppStore } from '@/store/index'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import './launch-work-item-direct-preflight'
import { inspectRequiredWorkspaceSetup as resolveDirectSetupDecision } from '../setup/workspace-setup-preparation'
import type { WorkspaceSetupInspection as DirectSetupInspection } from '../setup/workspace-setup-preparation'
import { confirmWorkspaceSetupDecision } from '../setup/workspace-setup-trust'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { SetupDecision } from '../../../../../../shared/worktree/create-types'

export type DirectWorkItemLaunchResult = boolean | 'cancelled'

let nextRequestId = 0

export type DirectWorkItemSetupRequest = {
  id: number
  repoName: string
  inspection: Exclude<DirectSetupInspection, { kind: 'decided' }>
  inspect: () => Promise<DirectSetupInspection>
  choose: (decision: SetupDecision) => void
  cancel: () => void
  isPending: () => boolean
}

/** Only the original launch creates/delivers; this slot returns its setup choice. */
export function requestDirectWorkItemSetup(
  repoName: string,
  inspection: DirectWorkItemSetupRequest['inspection'],
  inspect: DirectWorkItemSetupRequest['inspect'],
  signal?: AbortSignal
): Promise<SetupDecision | 'cancelled'> {
  if (signal?.aborted) {
    return Promise.resolve('cancelled')
  }
  return new Promise((resolve) => {
    let pending = true
    const finish = (decision: SetupDecision | 'cancelled'): void => {
      if (!pending) {
        return
      }
      pending = false
      signal?.removeEventListener('abort', cancel)
      resolve(decision)
      // Slot eviction has already installed its successor; never close that modal.
      if (useAppStore.getState().modalData?.directSetup === request) {
        useAppStore.getState().closeModal()
      }
    }
    const cancel = (): void => finish('cancelled')
    const request: DirectWorkItemSetupRequest = {
      id: ++nextRequestId,
      repoName,
      inspection,
      inspect,
      choose: finish,
      cancel,
      isPending: () => pending
    }
    signal?.addEventListener('abort', cancel, { once: true })
    useAppStore.getState().openModal('new-workspace-composer', {
      directSetup: request,
      [MODAL_DISMISSED_KEY]: cancel
    })
  })
}

export async function prepareDirectWorkItemSetup(
  repo: Repo,
  ownerHostId: ExecutionHostId,
  signal?: AbortSignal,
  onSetupRequired?: () => void
): Promise<
  ({ setupDecision: SetupDecision } & ApprovedSetupHashes) | 'cancelled' | 'review-request'
> {
  const inspection = await resolveDirectSetupDecision(repo.id, repo, ownerHostId)
  if (signal?.aborted) {
    return 'cancelled'
  }
  if (inspection.kind !== 'decided' && onSetupRequired) {
    onSetupRequired()
    return 'review-request'
  }
  const decision =
    inspection.kind === 'decided'
      ? inspection.decision
      : await requestDirectWorkItemSetup(
          repo.displayName,
          inspection,
          () => resolveDirectSetupDecision(repo.id, repo, ownerHostId),
          signal
        )
  if (decision === 'cancelled' || signal?.aborted) {
    return 'cancelled'
  }
  const confirmed = await confirmWorkspaceSetupDecision(
    useAppStore.getState(),
    repo.id,
    decision,
    ownerHostId,
    () => signal?.aborted === true,
    signal
  )
  if (confirmed === 'cancelled') {
    return 'cancelled'
  }
  return { setupDecision: confirmed.setupDecision, ...pickApprovedSetupHashes(confirmed) }
}
