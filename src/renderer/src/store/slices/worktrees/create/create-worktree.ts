import { showWorktreeCreateWarningToast } from './worktree-create-warning-toast'
import { reviewSetupTrustMismatch } from './created-worktree-setup-trust'
import { createWorktreeOnRuntimeHost, type HostCreateSettings } from './host-planned-agent-launch'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import { repoHostId } from '../listing/worktree-host-ownership'
import {
  isUnresolvedOwnerHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import { adoptFromEndpoint } from '../../../host-catalog/endpoint-catalog-adoption'
import type { WorktreeSlice } from '../worktree-slice-contract'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../../../../shared/new-workspace/worktree-create-retry-policy'
import { assertRuntimeEnvironmentCapability } from '../../../../runtime/rpc/compatibility/runtime-capability-proof'
import { runtimeTargetSupportsCapability } from '../../../../runtime/rpc/compatibility/runtime-target-capability'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { runtimeTargetForRepoOwner } from '@/lib/workspace/ownership/repo-runtime-owner'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  WORKTREE_OPEN_EXISTING_BRANCH_RUNTIME_CAPABILITY,
  WORKTREE_OPEN_EXISTING_BRANCH_V2_RUNTIME_CAPABILITY,
  WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY
} from '../../../../../../shared/worktree-runtime-capabilities'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/workspace-creation/base-ref-update/local-base-ref-suggestion-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/worktree-base-fallback-notice'
import { announcePerforceCopy } from '@/components/perforce-copies/perforce-copy-announcement'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'
import { applyCreatedWorktree } from './created-worktree-state-merge'
import { adoptRuntimeProvisionedRoot } from './runtime-provisioned-root-adoption'
import { isRuntimeLineageParentMissingError } from '../listing/runtime-worktree-rpc-errors'
import {
  buildLocalWorktreeCreateArgs,
  type CreatedWorktreeResult,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'
import { holdCreatedSidebarWorkspace } from '@/lib/sidebar-pending-layer'
import {
  resolveCreateCrossStoreParent,
  withoutRefusedInferredParent
} from './worktree-create-cross-store-parent'
import {
  lostRequestedParent,
  notifyWorktreeParentDropped,
  resolveWorktreeCreateParent,
  type CreateAttemptOutcome
} from './worktree-create-parent-pick'

type RuntimeTarget = RuntimeClientTarget

async function runCreateAttempt(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  target: RuntimeTarget,
  settings: HostCreateSettings
): Promise<CreateAttemptOutcome> {
  const provisionedRoot = request.options?.provisionedRoot
  const create = async (
    parentWorkspace: WorktreeCreateAttempt['parentWorkspace']
  ): Promise<CreatedWorktreeResult> =>
    provisionedRoot
      ? target.kind === 'environment'
        ? await adoptRuntimeProvisionedRoot(
            target,
            request,
            { ...attempt, parentWorkspace },
            provisionedRoot
          )
        : await window.api.worktrees.adoptProvisionedRoot({
            ...buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace }),
            ...provisionedRoot
          })
      : target.kind === 'local'
        ? // Why local can still reject on the parent: paired web clients route this API to their host.
          await window.api.worktrees.create(
            buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace })
          )
        : await createWorktreeOnRuntimeHost(
            target.environmentId,
            request,
            { ...attempt, parentWorkspace },
            settings
          )
  try {
    return { result: await create(attempt.parentWorkspace), droppedParent: false }
  } catch (error) {
    const unnested = withoutRefusedInferredParent(attempt, error)
    if (unnested) {
      return await runCreateAttempt(request, unnested, target, settings)
    }
    if (!attempt.parentWorkspace || !isRuntimeLineageParentMissingError(error)) {
      throw error
    }
    return { result: await create(undefined), droppedParent: true }
  }
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
      // Why: manual sort is user-authored order; stamp new workspaces at the top rather than relying on sortOrder fallback.
      const manualOrder = get().sortBy === 'manual' ? Date.now() : undefined
      if (isUnresolvedOwnerHostId(options?.executionHostId)) {
        // Why: the direct-SSH fallback below would otherwise create it on this machine.
        throw new Error('The workspace host is unresolved. Choose a host and retry.')
      }
      // Direct SSH still uses desktop IPC; paired runtimes use their captured environment.
      const target = options?.executionHostId
        ? (runtimeRpcTargetForAuthorityKey(options.executionHostId) ?? { kind: 'local' as const })
        : runtimeTargetForRepoOwner(get(), repoId)
      if (!target) {
        throw new Error('The project host is unresolved. Choose a host and retry.')
      }
      const creationHostId = adoptFromEndpoint(target, {
        kind: 'createdWorktree',
        requestedHostId: options?.executionHostId,
        resolveOwnHostId: () => repoHostId(get(), repoId)
      })
      if (options?.branchIntent === 'create-exact') {
        if (options.provisionedRoot) {
          throw new Error('An exact-name create cannot adopt a provisioned root.')
        }
        // The caller checked this host's capability; another await here would let the active parent drift.
        request.branchIntent = 'create-exact'
      } else if (options?.branchIntent) {
        const capability =
          options.branchIntent === 'open-existing-v2'
            ? WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY
            : options.branchIntent === 'create-new'
              ? WORKTREE_OPEN_EXISTING_BRANCH_V2_RUNTIME_CAPABILITY
              : WORKTREE_OPEN_EXISTING_BRANCH_RUNTIME_CAPABILITY
        if (!(await runtimeTargetSupportsCapability(target, capability))) {
          throw new Error(
            'Update Orca on the workspace host to reuse a branch or explicitly create a separate branch.'
          )
        }
        request.branchIntent = options.branchIntent
      }
      // Why outside the retry loop: a branch-name conflict retry must not re-warn about the same dropped pick.
      const parent = resolveWorktreeCreateParent(get(), options?.parentWorktreeId, creationHostId)
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
      const crossStoreParent = await resolveCreateCrossStoreParent(get(), target, {
        pick: parent,
        requestedParentWorktreeId: options?.parentWorktreeId,
        note: options?.note,
        warnParentDropped: warnParentDroppedOnce
      })
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
      if (
        options?.provisionedRoot &&
        target.kind === 'environment' &&
        options.provisionedRoot.executionHostId !== toRuntimeExecutionHostId(target.environmentId)
      ) {
        throw new Error("The provisioned root's host does not match the workspace host.")
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
              ...crossStoreParent,
              manualOrder
            },
            target,
            get().settings
          )
          if (lostRequestedParent(outcome, parent, target)) {
            warnParentDroppedOnce()
          }
          applyCreatedWorktree(set, repoId, outcome.result, creationHostId)
          const created = get().getKnownWorktreeById(outcome.result.worktree.id, creationHostId)
          if (created) {
            holdCreatedSidebarWorkspace({ worktree: created })
          }
          const { result } = outcome
          showWorktreeCreateWarningToast(result.warning)
          reviewSetupTrustMismatch(get, repoId, creationHostId, result, target)
          showLocalBaseRefRefreshToast(result.localBaseRefRefresh, result.worktree, {
            updateSettings: get().updateSettings,
            executionHostId: creationHostId
          })
          if (result.baseFallback) {
            requestWorktreeBaseFallbackNotice(result.baseFallback)
          }
          announcePerforceCopy(result.perforceCopy)
          showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
            updateSettings: get().updateSettings,
            getSettings: () => get().settings,
            openSettingsPage: get().openSettingsPage,
            openSettingsTarget: get().openSettingsTarget
          })
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry =
            request.branchIntent !== 'open-existing-v2' &&
            request.branchIntent !== 'create-exact' &&
            isRetryableWorktreeCreateConflict(message)
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
