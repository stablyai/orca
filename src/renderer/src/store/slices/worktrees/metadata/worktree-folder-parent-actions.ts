import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { callRuntimeRpc, RuntimeRpcCallError } from '../../../../runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '../../../../runtime/runtime-environment-revision'
import { fetchProjectGroupCatalogForTarget } from '../../../project-groups/project-group-catalog'
import { fetchFolderWorkspaceCatalogForTarget } from '../../../folder-workspaces/folder-workspace-catalog'
import {
  getEligibleFolderWorkspaceParents,
  type FolderParentCatalog,
  type FolderParentContext
} from '@/components/sidebar/folder-workspace-parent-candidates'
import { normalizeLineageResponse, type LineageListResponse } from './worktree-lineage-refresh'
import {
  findCapturedFolderParentChild,
  projectConfirmedFolderParent
} from './worktree-folder-parent-projection'
import {
  clearWorktreeParentMutationUncertain,
  markWorktreeParentMutationUncertain,
  withWorktreeParentMutation
} from './worktree-parent-mutation-guard'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'

export type FolderParentPickerData = FolderParentCatalog & {
  lineage: Readonly<Record<string, WorkspaceLineage>>
}

export class FolderParentMutationError extends Error {
  constructor(
    readonly outcome: 'rejected' | 'unknown' | 'acknowledged',
    message: string
  ) {
    super(message)
    this.name = 'FolderParentMutationError'
  }
}

const validationCodes = new Set([
  'LINEAGE_PARENT_NOT_FOUND',
  'LINEAGE_PARENT_CONTEXT_CONFLICT',
  'LINEAGE_PARENT_CONTEXT_MISSING',
  'LINEAGE_PARENT_CYCLE',
  'selector_not_found',
  'invalid_argument',
  'method_not_found',
  'forbidden'
])

export function createFolderParentActions(set: WorktreeSliceSet, get: WorktreeSliceGet) {
  const unverified = new Map<string, { folderId: string }>()
  const assertContext = (context: FolderParentContext): Worktree => {
    const current = findCapturedFolderParentChild(get(), context)
    if (
      !current ||
      (context.runtimeEnvironmentId &&
        getRuntimeEnvironmentRevision(context.runtimeEnvironmentId) !== context.environmentRevision)
    ) {
      throw new FolderParentMutationError(
        'rejected',
        'Workspace identity or execution owner changed.'
      )
    }
    return current
  }
  const rpcOptions = (context: FolderParentContext) => ({
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: context.environmentRevision
  })
  const readLineage = async (context: FolderParentContext) => {
    assertContext(context)
    const raw = await callRuntimeRpc<LineageListResponse>(
      context.target,
      'worktree.lineageList',
      undefined,
      rpcOptions(context)
    )
    assertContext(context)
    const snapshot = normalizeLineageResponse(raw)
    if (!snapshot.workspaceLineageAvailable) {
      throw new FolderParentMutationError('rejected', 'Folder lineage is unavailable on this host.')
    }
    return snapshot
  }
  const loadCatalog = async (context: FolderParentContext): Promise<FolderParentPickerData> => {
    assertContext(context)
    const wanted = unverified.get(context.mutationKey)
    const baseline = get()
    const groups = await fetchProjectGroupCatalogForTarget(context.target)
    assertContext(context)
    const folders = await fetchFolderWorkspaceCatalogForTarget(context.target, groups.projectGroups)
    assertContext(context)
    const { repos } = await callRuntimeRpc<{ repos: Repo[] }>(
      context.target,
      'repo.list',
      undefined,
      rpcOptions(context)
    )
    const snapshot = await readLineage(context)
    if (wanted && unverified.get(context.mutationKey) === wanted) {
      const current = assertContext(context)
      const edge = snapshot.workspaceLineageByChildKey[worktreeWorkspaceKey(current.id)]
      if (
        edge?.childInstanceId === context.instanceId &&
        edge.parentWorkspaceKey === folderWorkspaceKey(wanted.folderId)
      ) {
        let applied = false
        set((state) => {
          const projected = projectConfirmedFolderParent(state, context, edge, baseline)
          applied = projected !== null
          return projected ?? state
        })
        if (!applied) {
          throw new FolderParentMutationError('acknowledged', 'Parent view could not be refreshed.')
        }
      }
      // A fresh host snapshot permits an explicit retry; it never resends the timed-out write.
      unverified.delete(context.mutationKey)
      clearWorktreeParentMutationUncertain(context.mutationKey)
    }
    return {
      target: context.target,
      folderWorkspaces: folders.folderWorkspaces,
      projectGroups: groups.projectGroups,
      repos,
      lineage: snapshot.workspaceLineageByChildKey
    }
  }
  const attach = async (context: FolderParentContext, folderId: string): Promise<void> => {
    if (unverified.has(context.mutationKey)) {
      await loadCatalog(context)
    }
    return withWorktreeParentMutation(context.mutationKey, async () => {
      let sent = false
      let acknowledged = false
      try {
        const catalog = await loadCatalog(context)
        const candidate = getEligibleFolderWorkspaceParents(context, catalog, catalog.lineage).find(
          (entry) => entry.folder.id === folderId
        )
        if (!candidate) {
          throw new Error('Folder workspace is no longer eligible.')
        }
        if (candidate.isCurrent) {
          return
        }
        const current = assertContext(context)
        const key = worktreeWorkspaceKey(current.id)
        const existing = catalog.lineage[key]
        const visible = get().workspaceLineageByChildKey[key]
        if (
          (existing?.childInstanceId && existing.childInstanceId !== context.instanceId) ||
          (visible?.childInstanceId && visible.childInstanceId !== context.instanceId)
        ) {
          throw new Error('Existing parent belongs to another checkout instance.')
        }
        const baseline = get()
        sent = true
        const { worktree } = await callRuntimeRpc<{ worktree: Worktree }>(
          context.target,
          'worktree.set',
          {
            worktree: context.selector,
            parentWorktree: folderWorkspaceKey(folderId)
          },
          rpcOptions(context)
        )
        acknowledged = true
        assertContext(context)
        if (
          worktree.instanceId !== context.instanceId ||
          worktree.identity?.key !== context.identityKey
        ) {
          throw new Error('Updated checkout identity could not be verified.')
        }
        const snapshot = await readLineage(context)
        const edge = snapshot.workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)]
        if (
          edge?.childInstanceId !== context.instanceId ||
          edge.parentWorkspaceKey !== folderWorkspaceKey(folderId) ||
          snapshot.worktreeLineageById[worktree.id]
        ) {
          throw new Error('Folder parent could not be verified.')
        }
        let applied = false
        set((state) => {
          const projected = projectConfirmedFolderParent(state, context, edge, baseline)
          applied = projected !== null
          return projected ?? state
        })
        if (!applied) {
          throw new Error('Parent view changed before the confirmed update could be projected.')
        }
      } catch (error) {
        const rejected =
          !sent ||
          (!acknowledged && error instanceof RuntimeRpcCallError && validationCodes.has(error.code))
        if (!rejected) {
          unverified.set(context.mutationKey, { folderId })
          markWorktreeParentMutationUncertain(context.mutationKey)
        }
        throw new FolderParentMutationError(
          rejected ? 'rejected' : acknowledged ? 'acknowledged' : 'unknown',
          error instanceof Error ? error.message : 'Parent update failed.'
        )
      }
    })
  }
  return { loadFolderParentCatalog: loadCatalog, attachWorktreeToFolderWorkspace: attach }
}
