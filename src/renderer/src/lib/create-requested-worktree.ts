import { useAppStore } from '@/store'
import { getProvisionedRootCreateOptions } from '@/lib/provisioned-root-create-options'
import { resolveBackendDraftStartup } from '@/lib/worktree-draft-startup-view-mode'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { prepareComposerStartup } from './composer-deferred-startup'

/** Registers a durable workspace without revealing it or running renderer launch actions. */
export async function createRequestedWorktree(
  creationId: string,
  preparedRequest: WorktreeCreationRequest,
  background = false
): Promise<CreateWorktreeResult> {
  const provisionedRoot = getProvisionedRootCreateOptions(preparedRequest)
  const structuredLaunch = preparedRequest.agentLaunchRoute === 'structured-native-chat'
  const deferAgentLaunch = background && preparedRequest.agent !== null
  const backendStartup =
    provisionedRoot || structuredLaunch
      ? undefined
      : deferAgentLaunch
        ? await prepareComposerStartup(creationId, preparedRequest)
        : resolveBackendDraftStartup(preparedRequest)
  return useAppStore
    .getState()
    .createWorktree(
      preparedRequest.repoId,
      preparedRequest.name,
      preparedRequest.baseBranch,
      preparedRequest.setupDecision,
      preparedRequest.sparseCheckout,
      preparedRequest.telemetrySource,
      preparedRequest.displayName,
      preparedRequest.linkedIssue,
      preparedRequest.linkedPR,
      preparedRequest.pushTarget,
      preparedRequest.agent ?? undefined,
      preparedRequest.linkedLinearIssue,
      preparedRequest.branchNameOverride,
      preparedRequest.workspaceStatus,
      preparedRequest.linkedGitLabMR,
      preparedRequest.linkedGitLabIssue,
      backendStartup && background ? { ...backendStartup, activate: false } : backendStartup,
      structuredLaunch ? false : preparedRequest.pendingFirstAgentMessageRename,
      creationId,
      preparedRequest.linkedLinearIssueWorkspaceId,
      preparedRequest.linkedLinearIssueOrganizationUrlKey,
      preparedRequest.linkedBitbucketPR,
      preparedRequest.linkedAzureDevOpsPR,
      preparedRequest.linkedGiteaPR,
      preparedRequest.compareBaseRef,
      {
        callerOwnsCompletion: !background,
        ...(preparedRequest.nameWasGenerated ? { nameWasGenerated: true } : {}),
        ...(preparedRequest.displayNameKind
          ? { displayNameKind: preparedRequest.displayNameKind }
          : {}),
        ...(preparedRequest.linkedWorkItem !== undefined
          ? { linkedWorkItem: preparedRequest.linkedWorkItem }
          : {}),
        ...(preparedRequest.linkedTaskSourceContext !== undefined
          ? { linkedTaskSourceContext: preparedRequest.linkedTaskSourceContext }
          : {}),
        // Why: the remote host must own task-draft startup so its initial terminal is the agent, not an idle fallback shell.
        ...(!deferAgentLaunch &&
        !structuredLaunch &&
        !backendStartup &&
        preparedRequest.agent &&
        preparedRequest.launchDraftPrompt
          ? { startupDraft: preparedRequest.launchDraftPrompt }
          : {}),
        ...(provisionedRoot ? { provisionedRoot } : {}),
        ...(preparedRequest.parentWorktreeId
          ? { parentWorktreeId: preparedRequest.parentWorktreeId }
          : {})
      }
    )
}
