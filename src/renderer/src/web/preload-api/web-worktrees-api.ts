import type { PreloadApi } from '../../../../preload/api-types'
import type {
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { readRetiredNameRegistryForRepo } from '../../../../shared/worktree/retired-name-cache'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import type { Worktree } from '../../../../shared/worktree/types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import {
  callRuntimeResult,
  callRuntimeResultWithOwner,
  withRuntimeWorktreeOwner
} from './web-runtime-calls'
import { invalidateRuntimeWorktreeCaches } from './web-runtime-session'
import {
  WEB_RUNTIME_WORKTREE_LIST_LIMIT,
  callRuntimeDetectedWorktrees,
  listAllRuntimeWorktrees
} from './web-runtime-worktree-catalog'
import { noopUnsubscribe } from './web-storage'

export function createWorktreesApi(): NonNullable<Partial<PreloadApi>['worktrees']> {
  return {
    list: async ({ repoId }) => {
      const owned = await callRuntimeResultWithOwner<{ worktrees: Worktree[] }>('worktree.list', {
        repo: repoId,
        limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
      })
      return owned.result.worktrees.map((worktree) =>
        withRuntimeWorktreeOwner(worktree, owned.hostId)
      )
    },
    // Why the catch: a host predating this method answers `method_not_found`, and an empty list
    // degrades the suggestion to the pre-existing behavior rather than blocking workspace create.
    listRetiredNames: async ({ repoId }) => {
      try {
        return readRetiredNameRegistryForRepo(
          await callRuntimeResult<unknown>('worktree.listRetiredNames', { repo: repoId }),
          repoId
        )
      } catch {
        return EMPTY_RETIRED_NAME_REGISTRY
      }
    },
    listDetected: async ({ repoId }) => callRuntimeDetectedWorktrees(repoId),
    listAll: () => listAllRuntimeWorktrees(),
    create: async (args) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ worktree: Worktree }>('worktree.create', {
        repo: args.repoId,
        name: args.name,
        // Absent means user-typed, which is what the host must assume — so send it only when true.
        ...(args.nameWasGenerated ? { nameWasGenerated: true } : {}),
        baseBranch: args.baseBranch,
        compareBaseRef: args.compareBaseRef,
        branchNameOverride: args.branchNameOverride,
        linkedIssue: args.linkedIssue,
        linkedPR: args.linkedPR,
        linkedLinearIssue: args.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabIssue: args.linkedGitLabIssue,
        linkedGitLabMR: args.linkedGitLabMR,
        linkedBitbucketPR: args.linkedBitbucketPR,
        linkedAzureDevOpsPR: args.linkedAzureDevOpsPR,
        linkedGiteaPR: args.linkedGiteaPR,
        displayName: args.displayName,
        sparseCheckout: args.sparseCheckout,
        pushTarget: args.pushTarget,
        setupDecision: args.setupDecision,
        createdWithAgent: args.createdWithAgent,
        pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename,
        ...(args.startup
          ? {
              startupCommand: args.startup.command,
              ...(args.startup.env ? { startupEnv: args.startup.env } : {}),
              ...(args.startup.launchConfig
                ? { startupLaunchConfig: args.startup.launchConfig }
                : {}),
              ...(args.startup.startupCommandDelivery
                ? { startupCommandDelivery: args.startup.startupCommandDelivery }
                : {}),
              activate: true
            }
          : {}),
        parentWorkspace: args.parentWorkspace,
        // Why: every create through this API is an in-app action, never the CLI's parent flag.
        ...(args.parentWorkspace ? { parentWorkspaceOrigin: 'manual' } : {}),
        workspaceStatus: args.workspaceStatus,
        manualOrder: args.manualOrder,
        automationProvenanceRequest: args.automationProvenanceRequest
      })
      return {
        ...owned.result,
        worktree: withRuntimeWorktreeOwner(owned.result.worktree, owned.hostId)
      }
    },
    // Why: adoption verifies a desktop-owned hidden SSH target and is intentionally not a remote-server operation.
    adoptProvisionedRoot: () =>
      Promise.reject(
        new Error('Provisioned-root recipes require a direct SSH connection from the desktop app.')
      ),
    // Why: the runtime create path emits no two-phase progress, so the panel falls back to an indeterminate spinner.
    onCreateProgress: () => noopUnsubscribe,
    prefetchCreateBase: async ({ repoId, baseBranch }) => {
      await callRuntimeResult('worktree.prefetchCreateBase', {
        repo: repoId,
        baseBranch
      })
    },
    resolvePrBase: async ({ repoId, prNumber, headRefName, baseRefName, isCrossRepository }) =>
      callRuntimeResult('worktree.resolvePrBase', {
        repo: repoId,
        prNumber,
        headRefName,
        baseRefName,
        isCrossRepository
      }),
    resolveMrBase: async ({ repoId, mrIid, sourceBranch, targetBranch, isCrossRepository }) =>
      callRuntimeResult('worktree.resolveMrBase', {
        repo: repoId,
        mrIid,
        sourceBranch,
        targetBranch,
        isCrossRepository
      }),
    remove: async ({ worktreeId, hostId, force, allowUnverifiedPtyStop, skipArchive }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>('worktree.rm', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        ...(hostId ? { hostId } : {}),
        force,
        // Why (#11960): the web client renders the same Force Delete affordances, so
        // dropping this field here would leave paired clients permanently wedged.
        allowUnverifiedPtyStop,
        runHooks: skipArchive !== true
      })
    },
    // Why: forget-locally clears a desktop workspace pinned to a dead SSH host; a paired web client has no such ghost state.
    forgetLocal: () => {
      throw new Error('Forgetting a workspace is unavailable in paired web clients.')
    },
    forceDeletePreservedBranch: ({ worktreeId, branchName, expectedHead, hostId }) =>
      callRuntimeResult<ForceDeleteWorktreeBranchResult>('worktree.forceDeleteBranch', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        branchName,
        expectedHead,
        ...(hostId ? { hostId } : {})
      }),
    updateMeta: async ({ worktreeId, updates }) => {
      const rpcUpdates =
        Object.hasOwn(updates, 'pushTarget') && updates.pushTarget === undefined
          ? { ...updates, pushTarget: null }
          : updates
      const owned = await callRuntimeResultWithOwner<{ worktree: Worktree }>('worktree.set', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        ...rpcUpdates
      })
      return withRuntimeWorktreeOwner(owned.result.worktree, owned.hostId)
    },
    listLineage: async () =>
      await callRuntimeResult<{
        lineage: Record<string, WorktreeLineage>
        workspaceLineage?: Record<string, WorkspaceLineage>
      }>('worktree.lineageList'),
    updateLineage: async ({ worktreeId, parentWorktreeId, noParent }) => {
      invalidateRuntimeWorktreeCaches()
      const result = await callRuntimeResult<{
        worktree: Worktree & { lineage?: WorktreeLineage | null }
      }>('worktree.set', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        parentWorktree: parentWorktreeId,
        noParent
      })
      return result.worktree.lineage ?? null
    },
    persistSortOrder: async ({ orderedIds }) => {
      await callRuntimeResult('worktree.persistSortOrder', { orderedIds })
    },
    // Why: the capture lives in desktop main memory, unexposed over pairing; the dialog falls back to the persisted excerpt.
    getBranchRenameFailureOutput: async () => null,
    onChanged: () => noopUnsubscribe,
    onGitStatusMetadataChanged: () => noopUnsubscribe,
    onHeadIdentitiesChanged: () => noopUnsubscribe,
    onBaseStatus: () => noopUnsubscribe,
    onRemoteBranchConflict: () => noopUnsubscribe
  }
}
