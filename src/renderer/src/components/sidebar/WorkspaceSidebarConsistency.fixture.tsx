import { useAppStore } from '@/store'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import WorktreeCard from './workspace-card/surface/WorktreeCard'
import {
  getLineageChildrenInlineStyle,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from './worktree-list/rows/indentation'
import {
  FIXTURE_REPO,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from './worktree-card-slot-fixture-seeds'

const now = Date.now()
const seeds: WorkspaceSeed[] = [
  {
    id: 'explore',
    name: 'Explore workspace layout',
    agents: [
      { agentType: 'codex', state: 'done', minutesAgo: 1, message: 'Unify the workspace sidebar' }
    ]
  },
  { id: 'release-docs', name: 'release-checklist', agents: [] },
  { id: 'release-site', name: 'release-checklist', agents: [] }
]
const repos = [
  FIXTURE_REPO,
  ...seeds.slice(1).map((seed) => ({ ...FIXTURE_REPO, id: seed.id, displayName: seed.id }))
]
const worktrees = seeds.map((seed, index) => ({
  ...makeWorktree(seed, now),
  repoId: repos[index].id,
  branch: index === 0 ? 'feature/workspace-layout' : 'feature/release-checklist'
}))
const folders = [
  {
    id: 'notes',
    name: 'design-notes',
    folderPath: '/work/projects/design-notes'
  },
  { id: 'release', name: 'Release planning', folderPath: '/work/projects/release-planning' }
].map((folder) =>
  folderWorkspaceToWorktree({
    ...folder,
    projectGroupId: 'folders',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: now - 13 * 60_000
  })
)

function mixedFixture(width: number, detailsRow = true, hostLabel = 'Local Mac') {
  return defineFixture({
    width,
    setup: () => {
      seedWorkspaces(seeds, now)
      useAppStore.setState((state) => ({
        repos,
        projectGroups: [
          {
            id: 'folders',
            name: 'Folders',
            parentGroupId: null,
            parentPath: '/work/projects',
            createdFrom: 'folder-scan',
            tabOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: 0,
            updatedAt: 0
          }
        ],
        tabsByWorktree: Object.fromEntries(
          [...worktrees, ...folders].map((worktree) => [
            worktree.id,
            [
              ...(state.tabsByWorktree[worktree.id] ?? []),
              {
                id: `${worktree.id}-shell`,
                ptyId: `${worktree.id}-pty`,
                worktreeId: worktree.id,
                title: 'Shell',
                customTitle: null,
                color: null,
                sortOrder: 1,
                createdAt: now
              }
            ]
          ])
        ),
        ptyIdsByTabId: {
          ...state.ptyIdsByTabId,
          ...Object.fromEntries(
            [...worktrees, ...folders].map((worktree) => [
              `${worktree.id}-shell`,
              [`${worktree.id}-pty`]
            ])
          )
        },
        worktreesByRepo: Object.fromEntries(
          repos.map((repo, index) => [repo.id, [worktrees[index]]])
        ),
        settings: state.settings ? { ...state.settings, worktreeCardDetailsRow: detailsRow } : null,
        worktreeCardProperties: ['status', 'host', 'branch', 'inline-agents']
      }))
    },
    render: () => (
      <div className="flex flex-col gap-0.5 bg-worktree-sidebar p-1.5 text-worktree-sidebar-foreground">
        <WorktreeCard
          worktree={worktrees[0]}
          repo={repos[0]}
          isActive
          hostContextLabel={hostLabel}
          nativeDragEnabled={false}
        />
        <WorktreeCard
          worktree={folders[0]}
          repo={undefined}
          isActive={false}
          hostContextLabel={hostLabel}
          nativeDragEnabled={false}
        />
        <WorktreeCard
          worktree={folders[1]}
          repo={undefined}
          isActive={false}
          hostContextLabel={hostLabel}
          nativeDragEnabled={false}
          lineageChildCount={2}
          lineageChildWorktreeIds={worktrees.slice(1).map((worktree) => worktree.id)}
          lineageCollapsed={false}
          onLineageToggle={() => {}}
          lineageChildrenStyle={getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)}
          lineageChildren={worktrees.slice(1).map((worktree, index) => (
            <WorktreeCard
              key={worktree.id}
              worktree={worktree}
              repo={repos[index + 1]}
              isActive={false}
              hostContextLabel={hostLabel}
              nativeDragEnabled={false}
            />
          ))}
        />
      </div>
    )
  })
}

export const mixed = mixedFixture(390)
export const narrow = mixedFixture(280)
export const detailsHidden = mixedFixture(320, false)
export const longHost = mixedFixture(320, true, 'Remote development server')
