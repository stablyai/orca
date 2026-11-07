import { useAppStore } from '@/store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from '../drag/row-state'
import { renderFolderWorkspaceOption, type FolderWorkspaceRowContext } from './folder-row'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const group: ProjectGroup = {
  id: 'group-win',
  name: 'xm win folder',
  parentPath: 'C:/work/xm',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0,
  executionHostId: 'runtime:env-win'
}
const folder: FolderWorkspace = {
  id: 'folder-win',
  projectGroupId: group.id,
  name: 'xm win folder',
  folderPath: 'C:/work/xm',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0,
  executionHostId: 'runtime:env-win'
}
const repo: Repo = {
  id: 'repo-mac',
  path: '/Users/me/orca',
  displayName: 'orca',
  badgeColor: '#4f46e5',
  addedAt: 0
}
const worktree: Worktree = {
  id: 'repo-mac::/Users/me/orca/feature',
  instanceId: 'feature#instance',
  repoId: repo.id,
  path: '/Users/me/orca/feature',
  branch: 'refs/heads/feature',
  head: 'abc',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'feature',
  sortOrder: 1,
  lastActivityAt: 0,
  hostId: 'local'
}

// The real row plan decides each card's machine label; the cards render what it returns.
const rows = planSidebarRows({
  groupBy: 'none',
  sortBy: 'name',
  worktrees: [worktree],
  repoMap: new Map([[repo.id, repo]]),
  prGroupOf: () => 'in-progress',
  workspaceStatuses: cloneDefaultWorkspaceStatuses(),
  projectOrderBy: 'manual',
  lineageById: {},
  worktreeMap: new Map([[worktree.id, worktree]]),
  nestLineage: true,
  projectGroups: [group],
  placeholderRepoIds: new Set(),
  importedWorktreesByRepo: new Map(),
  newExternalWorktreesInboxByRepo: new Map(),
  pendingCreations: [],
  folderWorkspaces: [folder],
  defaultHostId: 'local',
  hostLabelById: new Map([
    ['local', 'Local Mac'],
    ['runtime:env-win', 'windows 2']
  ]),
  pinnedDisplayPolicy: 'single-location',
  filterRepoIds: []
}).render(new Set())

function FolderAndWorkspaceCards(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const ctx: FolderWorkspaceRowContext = {
    groupBy: 'none',
    newCardStyle: false,
    settings,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    currentWorktreeId: null,
    selectedWorktreeIds: new Set(),
    repoMap: new Map([[repo.id, repo]]),
    worktreeMap: new Map([[worktree.id, worktree]]),
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    crossStoreChildrenByFolderId: new Map(),
    prCache: null,
    hostedReviewCache: null,
    getCachedFolderWorkspacePathStatus: () => null,
    onSelectionGesture: () => false,
    onContextMenuSelect: () => [],
    onImmediateActivate: () => {},
    onRowClickCapture: () => {},
    onRowPointerDown: () => {},
    worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
    nativeLineageDropTargetIdentity: null
  }
  return (
    <div className="flex flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground">
      {rows.map((row) =>
        row.type === 'folder-workspace' ? (
          <div key={row.key}>{renderFolderWorkspaceOption({ ctx, row })}</div>
        ) : row.type === 'item' ? (
          <WorktreeCard
            key={row.rowKey}
            worktree={row.worktree}
            repo={row.repo}
            isActive={false}
            hostContextLabel={row.hostContextLabel}
          />
        ) : null
      )}
    </div>
  )
}

export const folderOnAnotherMachine = defineFixture({
  width: 300,
  store: { repos: [repo] },
  render: () => <FolderAndWorkspaceCards />
})
