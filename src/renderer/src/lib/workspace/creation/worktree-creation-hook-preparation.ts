import {
  pickApprovedSetupHashes,
  type ApprovedSetupHashes
} from '../../../../../shared/worktree/approved-setup-hashes'
import { useAppStore } from '@/store/index'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import {
  ensureHooksConfirmed,
  readAndConfirmRuntimeIssueCommand
} from '../../../runtime/repo-hooks/ensure-hooks-confirmed'
import { confirmWorkspaceSetupDecision } from './setup/workspace-setup-trust'
import { buildTrustedComposerIssueCommand } from './composer-issue-command'
import { getInitialWorktreeCreationPhase } from './worktree-creation-flow-startup'

export async function prepareWorktreeCreationHooks(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<WorktreeCreationRequest | null> {
  const preparation = request.hookPreparation
  if (!preparation) {
    return request
  }

  const isCancelled = (): boolean => !useAppStore.getState().pendingWorktreeCreations[creationId]
  const confirmHook = (kind: 'setup' | 'vmRecipe'): Promise<'run' | 'skip'> =>
    ensureHooksConfirmed(
      useAppStore.getState,
      request.repoId,
      kind,
      preparation.executionHostId,
      undefined,
      isCancelled
    )
  const confirmed = await confirmWorkspaceSetupDecision(
    useAppStore.getState,
    request.repoId,
    request.setupDecision,
    preparation.executionHostId,
    isCancelled
  )
  if (confirmed === 'cancelled') {
    return null
  }

  const { setupDecision, trustDecision } = confirmed
  let issueCommand = request.issueCommand
  if (preparation.issueCommand && preparation.executionHostId && trustDecision !== 'skip') {
    const confirmed = await readAndConfirmRuntimeIssueCommand(
      useAppStore.getState(),
      request.repoId,
      preparation.executionHostId,
      isCancelled
    )
    if (isCancelled()) {
      return null
    }
    issueCommand = buildTrustedComposerIssueCommand({
      ...preparation.issueCommand,
      enabled: true,
      template: confirmed.template,
      trustDecision: confirmed.trustDecision
    })
  }

  if (preparation.confirmVmRecipe) {
    const decision = await confirmHook('vmRecipe')
    if (isCancelled()) {
      return null
    }
    if (decision === 'skip') {
      useAppStore.getState().removePendingWorktreeCreation(creationId)
      return null
    }
  }

  const prepared: WorktreeCreationRequest = {
    ...request,
    hookPreparation: undefined,
    executionHostId: request.executionHostId ?? preparation.executionHostId,
    setupDecision,
    ...pickApprovedSetupHashes(confirmed),
    issueCommand
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    request: prepared,
    phase: getInitialWorktreeCreationPhase(prepared)
  })
  return prepared
}

/** Setup fields for the create call; the approved hash lets the host check the created branch. */
export function setupCreateArgs(
  request: Pick<WorktreeCreationRequest, 'setupOnly' | keyof ApprovedSetupHashes>
): { setupOnly?: boolean } & ApprovedSetupHashes {
  return { setupOnly: request.setupOnly, ...pickApprovedSetupHashes(request) }
}
