import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceAttachmentSourceContext } from '@/components/sidebar/workspace-card/review/workspace-attachment-source-result'
import { getWorkspaceReferenceLinearWorkspaceId } from '@/components/sidebar/workspace-card/review/workspace-reference-details'
import { findIndexedWorktrees } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import {
  resolveQualifiedIndexedFolderWorkspace,
  selectFolderWorkspaceCopies
} from '@/store/folder-workspaces/folder-workspace-record-index'
import { getFolderWorkspaceWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { rowLessSourceTarget } from '@/runtime/hosts/selection/default-creation-host'
import {
  getLinearReadScope,
  scopedLinearCacheKey,
  type LinearReadScope
} from '@/store/slices/linear/linear-slice-scope'
import { inflightIssueRequests } from '@/store/slices/linear/linear-slice-request-state'

type Update = Extract<RuntimeClientEvent, { type: 'linearLinkedIssueUpdated' }>
type Target = {
  scope: LinearReadScope
  identifier: string
  workspaceId?: string | null
}
const sameEndpoint = (a: RuntimeClientTarget, b: RuntimeClientTarget): boolean =>
  a.kind === b.kind &&
  (a.kind === 'local' || (b.kind === 'environment' && a.environmentId === b.environmentId))

function updatedWorkspace(
  state: AppState,
  endpoint: RuntimeClientTarget,
  id: string
): Worktree | undefined {
  if (endpoint.kind === 'environment') {
    return selectWorkspaceByHostTarget(
      state,
      hostWorktreeTarget({ id, hostId: toRuntimeExecutionHostId(endpoint.environmentId) })
    )
  }
  const folder = parseWorkspaceKey(id)
  if (folder?.type === 'folder') {
    const copies = selectFolderWorkspaceCopies(state, folder.folderWorkspaceId)
    const candidates = copies.flatMap((copy) => {
      const result = resolveQualifiedIndexedFolderWorkspace(
        state,
        copy.id,
        copies.length === 1 ? undefined : getRepoExecutionHostId(copy)
      )
      return result.kind === 'selected' &&
        parseExecutionHostId(result.value.hostId)?.kind !== 'runtime'
        ? [result.value]
        : []
    })
    return candidates.length === 1
      ? getFolderWorkspaceWorktree(candidates[0].workspace, candidates[0])
      : undefined
  }
  const candidates = findIndexedWorktrees(state.worktreesByRepo, id).filter(
    (row) => !row.runtimeOwnerEnvironmentId && parseExecutionHostId(row.hostId)?.kind !== 'runtime'
  )
  return candidates.length === 1
    ? selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id, hostId: candidates[0].hostId ?? 'local' })
      )
    : undefined
}

export function resolveLinearLinkedIssueRefreshTargets(
  state: AppState,
  endpoint: RuntimeClientTarget,
  event: Update
): Target[] {
  const workspace = updatedWorkspace(state, endpoint, event.worktreeId)
  if (!workspace) {
    return []
  }
  const repoHost =
    endpoint.kind === 'environment'
      ? toRuntimeExecutionHostId(endpoint.environmentId)
      : (workspace.hostId ?? 'local')
  const repo = findIndexedRepoOwnerForHost(state.repos, workspace.repoId, repoHost)
  const targets: Target[] = []
  const items = [...getWorkspaceAttachments(workspace)]
  if (workspace.linkedLinearIssue) {
    items.push({
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: workspace.linkedLinearIssue,
      linearWorkspaceId: workspace.linkedLinearIssueWorkspaceId ?? undefined,
      taskSourceContext:
        getWorkspaceAttachmentSourceContext('linear', repo ?? undefined, workspace) ?? undefined
    })
  }
  for (const item of items) {
    const identifier = item.identifier ?? item.linearIdentifier
    if (
      item.provider !== 'linear' ||
      !identifier ||
      identifier.toUpperCase() !== event.identifier.toUpperCase()
    ) {
      continue
    }
    const source =
      item.taskSourceContext ??
      getWorkspaceAttachmentSourceContext('linear', repo ?? undefined, workspace)
    if (
      !source ||
      source.provider !== 'linear' ||
      (source.providerIdentity?.provider === 'linear' &&
        source.providerIdentity.workspaceId &&
        source.providerIdentity.workspaceId !== 'all' &&
        source.providerIdentity.workspaceId !== event.workspaceId)
    ) {
      continue
    }
    const scope = getLinearReadScope(state.settings, source)
    if (!sameEndpoint(rowLessSourceTarget(scope.settings), endpoint)) {
      continue
    }
    const workspaceId = getWorkspaceReferenceLinearWorkspaceId(item.linearWorkspaceId, source)
    if (workspaceId !== 'all' && workspaceId !== event.workspaceId) {
      continue
    }
    const key = scopedLinearCacheKey(scope, `${workspaceId}::${identifier}`)
    const cached = state.linearIssueCache[key]
    const live = inflightIssueRequests.get(JSON.stringify([scope.contextKey, key]))
    if (!cached && !live) {
      continue
    }
    const lease = live?.acquire()
    let account: string | undefined
    try {
      account = cached?.data?.workspaceId ?? lease?.currentView().data?.workspaceId
    } finally {
      lease?.release()
    }
    if (!account || account === event.workspaceId) {
      targets.push({ scope, identifier, workspaceId })
    }
  }
  return targets
}
