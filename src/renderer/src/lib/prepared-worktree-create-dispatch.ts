import { useAppStore } from '@/store'
import { getProvisionedRootCreateOptions } from '@/lib/provisioned-root-create-options'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/types'

/** Adapts a prepared creation request onto the store's positional `createWorktree`
 *  signature. Throws on incomplete provisioned-root identity, so callers must run
 *  it inside the same try that reports create failures. */
export function dispatchPreparedWorktreeCreate(
  creationId: string,
  preparedRequest: WorktreeCreationRequest
): Promise<CreateWorktreeResult> {
  const provisionedRoot = getProvisionedRootCreateOptions(preparedRequest)
  return useAppStore.getState().createWorktree(
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
    // The host owns startup resolution via `agentLaunch`; the legacy
    // self-contained startup arg is never used on the create path.
    undefined,
    preparedRequest.pendingFirstAgentMessageRename,
    creationId,
    preparedRequest.linkedLinearIssueWorkspaceId,
    preparedRequest.linkedLinearIssueOrganizationUrlKey,
    preparedRequest.linkedBitbucketPR,
    preparedRequest.linkedAzureDevOpsPR,
    preparedRequest.linkedGiteaPR,
    preparedRequest.compareBaseRef,
    {
      ...(preparedRequest.nameWasGenerated ? { nameWasGenerated: true } : {}),
      ...(preparedRequest.linkedWorkItem !== undefined
        ? { linkedWorkItem: preparedRequest.linkedWorkItem }
        : {}),
      ...(preparedRequest.linkedTaskSourceContext !== undefined
        ? { linkedTaskSourceContext: preparedRequest.linkedTaskSourceContext }
        : {}),
      ...(preparedRequest.agentLaunch
        ? {
            agentLaunch: preparedRequest.agentLaunch,
            // The host emits agent_started off its validated receipt; only the
            // surface-owned launch_source/request_kind cross, so derive them from
            // the quick telemetry the composer already captured.
            ...(preparedRequest.quickTelemetry
              ? {
                  agentLaunchTelemetry: {
                    launch_source: preparedRequest.quickTelemetry.launch_source,
                    request_kind: preparedRequest.quickTelemetry.request_kind
                  }
                }
              : {})
          }
        : {}),
      ...(provisionedRoot ? { provisionedRoot } : {})
    }
  )
}
