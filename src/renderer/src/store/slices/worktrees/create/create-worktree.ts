import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../../../../shared/new-workspace/worktree-create-retry-policy'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../../../runtime/runtime-rpc-client'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/local-base-ref-suggestion-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/worktree-base-fallback-notice'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'
import { settingsForRepoOwner } from '../listing/worktree-owner-settings'
import { applyCreatedWorktree } from './created-worktree-state-merge'
import { isRuntimeLineageParentMissingError } from '../listing/runtime-worktree-rpc-errors'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'
import {
  notifyWorktreeParentDropped,
  resolveWorktreeCreateParent,
  type WorktreeCreateParentPick
} from './worktree-create-parent-pick'

type RuntimeTarget = ReturnType<typeof getActiveRuntimeTarget>

type CreateAttemptOutcome = {
  result: CreateWorktreeResult
  /** The host had no such parent, so this attempt was retried unattached. */
  droppedParent: boolean
}

async function runCreateAttempt(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  target: RuntimeTarget
): Promise<CreateAttemptOutcome> {
  const provisionedRoot = request.options?.provisionedRoot
  const create = async (
    parentWorkspace: WorktreeCreateAttempt['parentWorkspace']
  ): Promise<CreateWorktreeResult> =>
    provisionedRoot
      ? await window.api.worktrees.adoptProvisionedRoot({
          ...buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace }),
          ...provisionedRoot
        })
      : target.kind === 'local'
        ? // Why local can still reject on the parent: paired web clients route this API to their host.
          await window.api.worktrees.create(
            buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace })
          )
        : await callRuntimeRpc<CreateWorktreeResult>(
            target,
            'worktree.create',
            buildRuntimeWorktreeCreateParams(request, { ...attempt, parentWorkspace }),
            { timeoutMs: 10 * 60_000 }
          )
  try {
    return { result: await create(attempt.parentWorkspace), droppedParent: false }
  } catch (error) {
    if (!attempt.parentWorkspace || !isRuntimeLineageParentMissingError(error)) {
      throw error
    }
    return { result: await create(undefined), droppedParent: true }
  }
}

/** True when the create landed without the nesting the caller asked for. */
function lostRequestedParent(
  outcome: CreateAttemptOutcome,
  parent: WorktreeCreateParentPick,
  target: RuntimeTarget
): boolean {
  if (outcome.droppedParent) {
    return true
  }
  if (parent.pickedParentWorktreeId) {
    return !outcome.result.lineage
  }
  // Why local-only: older hosts predate the top-level workspace lineage field, so its absence
  // over RPC would warn about a nesting that actually landed.
  return (
    target.kind === 'local' && Boolean(parent.parentWorkspace) && !outcome.result.workspaceLineage
  )
}

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
    const agentLaunch = options?.agentLaunch
    const agentLaunchTelemetry = options?.agentLaunchTelemetry
    try {
      // Why outside the retry loop: a branch-name conflict retry must not re-warn about the same dropped pick.
      const parent = resolveWorktreeCreateParent(get(), repoId, options?.parentWorktreeId)
      let warnedParentDropped = false
      const warnParentDroppedOnce = (): void => {
        if (warnedParentDropped) {
          return
        }
        warnedParentDropped = true
        notifyWorktreeParentDropped(get(), parent)
      }
      if (parent.staleBeforeCreate) {
        warnParentDroppedOnce()
      }
      // Why: manual sort is user-authored order; stamp new workspaces at the top rather than relying on sortOrder fallback.
      const manualOrder = get().sortBy === 'manual' ? Date.now() : undefined
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      if (
        target.kind === 'environment' &&
        (options?.linkedWorkItem?.provider === 'jira' ||
          options?.linkedTaskSourceContext?.provider === 'jira')
      ) {
        await assertRuntimeEnvironmentCapability(
          target.environmentId,
          WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
          'Update the remote runtime to link Jira'
        )
      }
      if (options?.provisionedRoot && target.kind !== 'local') {
        throw new Error('Provisioned-root recipes currently require a direct SSH connection.')
      }
      for (let attempt = 0; attempt < CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
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
            ...(automationProvenanceRequest ? { automationProvenanceRequest } : {}),
            ...(agentLaunch ? { agentLaunch } : {}),
            ...(agentLaunchTelemetry ? { agentLaunchTelemetry } : {})
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
                      : {}),
                    ...(agentLaunch ? { agentLaunch } : {}),
                    ...(agentLaunchTelemetry ? { agentLaunchTelemetry } : {})
                  },
                  { timeoutMs: 10 * 60_000 }
                )
          // A pre-create launch rejection creates no worktree and must be returned
          // in-band so the composer can preserve its draft and recovery hints.
          if (result.created === false) {
            return result
          }
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
