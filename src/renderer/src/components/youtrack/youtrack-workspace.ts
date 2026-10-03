import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { getLinkedWorkItemWorkspaceName } from '../../../../shared/workspace-name'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import type { YouTrackIssue } from '../../../../shared/youtrack-types'

type AppState = ReturnType<typeof useAppStore.getState>

export function buildYouTrackLinkedWorkItem(issue: YouTrackIssue): LinkedWorkItemSummary {
  return {
    type: 'issue',
    provider: 'youtrack',
    // Why: the linked-item shape is numeric for GitHub/GitLab; string-keyed providers use 0.
    number: 0,
    title: `${issue.idReadable} ${issue.summary}`,
    url: issue.url,
    youtrackIdentifier: issue.idReadable
  }
}

/** The YouTrack issue a live workspace is linked to, upper-cased; null otherwise. */
function linkedIssueId(worktree: Worktree): string | null {
  const item = worktree.linkedWorkItem
  return !worktree.isArchived && item?.provider === 'youtrack' && item.youtrackIdentifier
    ? item.youtrackIdentifier.toUpperCase()
    : null
}

function findInState(state: AppState, idReadable: string): Worktree | null {
  const wanted = idReadable.toUpperCase()
  const workspaces = [
    ...state.allWorktrees(),
    ...state.folderWorkspaces.map(folderWorkspaceToWorktree)
  ]
  return workspaces.find((worktree) => linkedIssueId(worktree) === wanted) ?? null
}

export function findYouTrackIssueWorkspace(idReadable: string): Worktree | null {
  return findInState(useAppStore.getState(), idReadable)
}

// Why: the selector reruns on every store write; cache linked IDs per snapshot identity.
const linkedIdsByWorktrees = new WeakMap<AppState['worktreesByRepo'], Set<string>>()
const linkedIdsByFolders = new WeakMap<AppState['folderWorkspaces'], Set<string>>()

function collectLinkedIds(workspaces: readonly Worktree[]): Set<string> {
  return new Set(workspaces.map(linkedIssueId).filter((id) => id !== null))
}

function hasLinkedWorkspace(state: AppState, wanted: string): boolean {
  let worktreeIds = linkedIdsByWorktrees.get(state.worktreesByRepo)
  if (!worktreeIds) {
    worktreeIds = collectLinkedIds(getIndexedAllWorktrees(state.worktreesByRepo))
    linkedIdsByWorktrees.set(state.worktreesByRepo, worktreeIds)
  }
  if (worktreeIds.has(wanted)) {
    return true
  }
  let folderIds = linkedIdsByFolders.get(state.folderWorkspaces)
  if (!folderIds) {
    folderIds = collectLinkedIds(state.folderWorkspaces.map(folderWorkspaceToWorktree))
    linkedIdsByFolders.set(state.folderWorkspaces, folderIds)
  }
  return folderIds.has(wanted)
}

/** Subscribes so the label flips once worktrees hydrate or a linked one is created. */
export function useHasYouTrackIssueWorkspace(idReadable: string | null): boolean {
  return useAppStore((state) =>
    idReadable ? hasLinkedWorkspace(state, idReadable.toUpperCase()) : false
  )
}

export function openYouTrackIssueWorkspace(worktree: Worktree): void {
  const scope = parseWorkspaceKey(worktree.id)
  const hostOptions = worktree.hostId ? { executionHostId: worktree.hostId } : {}
  const activation =
    scope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(scope.folderWorkspaceId, {
          navigationIntent: 'user-open',
          ...hostOptions
        })
      : activateAndRevealWorktree(worktree.id, { navigationIntent: 'user-open', ...hostOptions })
  if (activation === false) {
    toast.error(
      translate('youtrack.workspace.openFailed', 'Unable to open the workspace for this issue.')
    )
  }
}

/** Opens the workspace already linked to the issue, otherwise the pre-filled create dialog. */
export function startYouTrackIssueWorkspace(issue: YouTrackIssue): void {
  const existing = findYouTrackIssueWorkspace(issue.idReadable)
  if (existing) {
    openYouTrackIssueWorkspace(existing)
    return
  }
  const linkedWorkItem = buildYouTrackLinkedWorkItem(issue)
  useAppStore.getState().openModal('new-workspace-composer', {
    linkedWorkItem,
    prefilledName: getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ?? '',
    telemetrySource: 'sidebar'
  })
}
