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
    const request: WorktreeCreateRequest = {
      repoId,
      name,
      baseBranch,
      setupDecision,
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
    }
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
          const outcome = await runCreateAttempt(
            request,
            {
              name: options?.nameWasGenerated
                ? getGeneratedWorktreeCreateRetryCandidate(name, attempt)
                : getClientWorktreeCreateCandidate(name, attempt),
              // Why: older runtimes reject exact PR branch overrides on collision, so retry both branch and worktree names.
              branchNameOverride: branchNameOverride
                ? getClientWorktreeCreateCandidate(branchNameOverride, attempt)
                : undefined,
              parentWorkspace: parent.parentWorkspace,
              manualOrder
            },
            target
          )
          if (lostRequestedParent(outcome, parent, target)) {
            warnParentDroppedOnce()
          }
          applyCreatedWorktree(set, repoId, outcome.result)
          const { result } = outcome
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
