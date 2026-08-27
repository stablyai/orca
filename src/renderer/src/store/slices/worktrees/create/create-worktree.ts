import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../../../../shared/new-workspace/worktree-create-retry-policy'
import { parseWorkspaceKey, folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../../../runtime/runtime-rpc-client'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/local-base-ref-suggestion-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/worktree-base-fallback-notice'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'
import {
  getProjectHostSetupForRepoHost,
  repoHostId,
  withRepoHostOwnership
} from '../listing/worktree-host-ownership'
import { settingsForRepoOwner } from '../listing/worktree-owner-settings'

export function createCreateWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['createWorktree'] {
  return async (
    repoId,
    name,
    baseBranch,
    setupDecision = 'inherit',
    sparseCheckout,
    telemetrySource,
    displayName,
    linkedIssue,
    linkedPR,
    pushTarget,
    createdWithAgent,
    linkedLinearIssue,
    branchNameOverride,
    workspaceStatus,
    linkedGitLabMR,
    linkedGitLabIssue,
    startup,
    pendingFirstAgentMessageRename,
    creationId,
    linkedLinearIssueWorkspaceId,
    linkedLinearIssueOrganizationUrlKey,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    compareBaseRef,
    options
  ) => {
    const automationProvenanceRequest = options?.automationProvenanceRequest
    const linkedWorkItem = options?.linkedWorkItem
    const linkedTaskSourceContext = options?.linkedTaskSourceContext
    const startupDraft = options?.startupDraft
    const provisionedRoot = options?.provisionedRoot
    try {
      for (let attempt = 0; attempt < CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
        const candidateName = options?.nameWasGenerated
          ? getGeneratedWorktreeCreateRetryCandidate(name, attempt)
          : getClientWorktreeCreateCandidate(name, attempt)
        // Why: older runtimes reject exact PR branch overrides on collision, so retry both branch and worktree names.
        const candidateBranchNameOverride = branchNameOverride
          ? getClientWorktreeCreateCandidate(branchNameOverride, attempt)
          : undefined
        try {
          // Why: manual sort is user-authored order; stamp new workspaces at the top rather than relying on sortOrder fallback.
          const manualOrder = get().sortBy === 'manual' ? Date.now() : undefined
          const activeScope = parseWorkspaceKey(get().activeWorkspaceKey ?? '')
          const parentWorkspace =
            activeScope?.type === 'folder'
              ? folderWorkspaceKey(activeScope.folderWorkspaceId)
              : undefined
          const createArgs = {
            repoId,
            name: candidateName,
            ...(options?.nameWasGenerated ? { nameWasGenerated: true } : {}),
            baseBranch,
            ...(compareBaseRef ? { compareBaseRef } : {}),
            ...(candidateBranchNameOverride
              ? { branchNameOverride: candidateBranchNameOverride }
              : {}),
            setupDecision,
            sparseCheckout,
            ...(displayName ? { displayName } : {}),
            ...(telemetrySource ? { telemetrySource } : {}),
            ...(linkedIssue !== undefined ? { linkedIssue } : {}),
            ...(linkedPR !== undefined ? { linkedPR } : {}),
            ...(pushTarget ? { pushTarget } : {}),
            ...(createdWithAgent ? { createdWithAgent } : {}),
            ...(pendingFirstAgentMessageRename === true && createdWithAgent
              ? { pendingFirstAgentMessageRename: true }
              : {}),
            ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
            ...(linkedLinearIssueWorkspaceId !== undefined ? { linkedLinearIssueWorkspaceId } : {}),
            ...(linkedLinearIssueOrganizationUrlKey !== undefined
              ? { linkedLinearIssueOrganizationUrlKey }
              : {}),
            ...(manualOrder !== undefined ? { manualOrder } : {}),
            ...(parentWorkspace ? { parentWorkspace } : {}),
            ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
            ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
            ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {}),
            ...(linkedBitbucketPR !== undefined ? { linkedBitbucketPR } : {}),
            ...(linkedAzureDevOpsPR !== undefined ? { linkedAzureDevOpsPR } : {}),
            ...(linkedGiteaPR !== undefined ? { linkedGiteaPR } : {}),
            ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
            ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {}),
            ...(startup ? { startup } : {}),
            ...(creationId ? { creationId } : {}),
            ...(automationProvenanceRequest ? { automationProvenanceRequest } : {})
          }
          const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
          if (
            target.kind === 'environment' &&
            (linkedWorkItem?.provider === 'jira' || linkedTaskSourceContext?.provider === 'jira')
          ) {
            await assertRuntimeEnvironmentCapability(
              target.environmentId,
              WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
              'Update the remote runtime to link Jira'
            )
          }
          if (provisionedRoot && target.kind !== 'local') {
            throw new Error('Provisioned-root recipes currently require a direct SSH connection.')
          }
          const result = provisionedRoot
            ? await window.api.worktrees.adoptProvisionedRoot({
                ...createArgs,
                ...provisionedRoot
              })
            : target.kind === 'local'
              ? await window.api.worktrees.create(createArgs)
              : await callRuntimeRpc<Awaited<ReturnType<typeof window.api.worktrees.create>>>(
                  target,
                  'worktree.create',
                  {
                    repo: repoId,
                    name: candidateName,
                    ...(options?.nameWasGenerated ? { nameWasGenerated: true } : {}),
                    baseBranch,
                    ...(compareBaseRef ? { compareBaseRef } : {}),
                    ...(candidateBranchNameOverride
                      ? { branchNameOverride: candidateBranchNameOverride }
                      : {}),
                    setupDecision,
                    sparseCheckout,
                    ...(displayName ? { displayName } : {}),
                    ...(telemetrySource ? { telemetrySource } : {}),
                    ...(linkedIssue !== undefined ? { linkedIssue } : {}),
                    ...(linkedPR !== undefined ? { linkedPR } : {}),
                    ...(pushTarget ? { pushTarget } : {}),
                    ...(createdWithAgent ? { createdWithAgent } : {}),
                    ...(pendingFirstAgentMessageRename === true && createdWithAgent
                      ? { pendingFirstAgentMessageRename: true }
                      : {}),
                    ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
                    ...(linkedLinearIssueWorkspaceId !== undefined
                      ? { linkedLinearIssueWorkspaceId }
                      : {}),
                    ...(linkedLinearIssueOrganizationUrlKey !== undefined
                      ? { linkedLinearIssueOrganizationUrlKey }
                      : {}),
                    ...(manualOrder !== undefined ? { manualOrder } : {}),
                    ...(parentWorkspace ? { parentWorkspace } : {}),
                    ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
                    ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
                    ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {}),
                    ...(linkedBitbucketPR !== undefined ? { linkedBitbucketPR } : {}),
                    ...(linkedAzureDevOpsPR !== undefined ? { linkedAzureDevOpsPR } : {}),
                    ...(linkedGiteaPR !== undefined ? { linkedGiteaPR } : {}),
                    ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
                    ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {}),
                    ...(startupDraft ? { startupDraft } : {}),
                    ...(automationProvenanceRequest ? { automationProvenanceRequest } : {}),
                    ...(startup
                      ? {
                          startupCommand: startup.command,
                          ...(startup.env ? { startupEnv: startup.env } : {}),
                          ...(startup.launchConfig
                            ? { startupLaunchConfig: startup.launchConfig }
                            : {}),
                          ...(startup.startupCommandDelivery
                            ? { startupCommandDelivery: startup.startupCommandDelivery }
                            : {}),
                          activate: true
                        }
                      : {})
                  },
                  { timeoutMs: 10 * 60_000 }
                )
          // Why: worktrees.onChanged can add this worktree before this callback runs; appending blindly would duplicate it (React key clash).
          set((s) => {
            const hostId = repoHostId(s, repoId)
            const createdWorktree = withRepoHostOwnership(
              result.worktree,
              hostId,
              getProjectHostSetupForRepoHost(s, repoId, hostId)
            )
            const current = s.worktreesByRepo[repoId] ?? []
            const alreadyPresent = current.some((w) => w.id === createdWorktree.id)
            const nextWorktrees = alreadyPresent
              ? current.map((worktree) =>
                  worktree.id === createdWorktree.id
                    ? { ...worktree, ...createdWorktree }
                    : worktree
                )
              : [...current, createdWorktree]
            return {
              worktreesByRepo: {
                ...s.worktreesByRepo,
                [repoId]: nextWorktrees
              },
              ...(result.workspaceLineage
                ? {
                    workspaceLineageByChildKey: {
                      ...s.workspaceLineageByChildKey,
                      [result.workspaceLineage.childWorkspaceKey]: result.workspaceLineage
                    }
                  }
                : {}),
              ...(result.initialBaseStatus
                ? {
                    baseStatusByWorktreeId: {
                      ...s.baseStatusByWorktreeId,
                      [result.worktree.id]:
                        s.baseStatusByWorktreeId[result.worktree.id] ?? result.initialBaseStatus
                    }
                  }
                : {}),
              sortEpoch: s.sortEpoch + 1
            }
          })
          showLocalBaseRefRefreshToast(result.localBaseRefRefresh, result.worktree)
          if (result.baseFallback) {
            requestWorktreeBaseFallbackNotice(result.baseFallback)
          }
          showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
            updateSettings: get().updateSettings,
            getSettings: () => get().settings,
            openSettingsPage: get().openSettingsPage,
            openSettingsTarget: get().openSettingsTarget
          })
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry = isRetryableWorktreeCreateConflict(message)
          if (!shouldRetry || attempt === CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS - 1) {
            throw error
          }
        }
      }

      throw new Error('Failed to create worktree after retrying branch conflicts.')
    } catch (err) {
      console.error('Failed to create worktree:', err)
      throw err
    }
  }
}
