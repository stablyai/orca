import { useRef } from 'react'
import { useAppStore } from '@/store'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import {
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from '../../worktree-card-slot-fixture-seeds'
import WorktreeList from '../listing/WorktreeList'

const groups: ProjectGroup[] = [
  { id: 'work', name: 'Work', color: '#8b5cf6', tabOrder: 0 },
  { id: 'personal', name: 'Personal', color: '#14b8a6', tabOrder: 1 },
  { id: 'archive', name: 'Archive', color: '#f97316', tabOrder: 2 }
].map((group) => ({
  ...group,
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  isCollapsed: false,
  createdAt: 1,
  updatedAt: 1
}))

const repos: Repo[] = [
  { id: 'repo-orca', displayName: 'orca', projectGroupId: 'work' },
  { id: 'repo-api', displayName: 'api-server', projectGroupId: 'work' },
  { id: 'repo-quest', displayName: 'side-quest', projectGroupId: 'personal' },
  { id: 'repo-docs', displayName: 'notes', projectGroupId: 'archive' }
].map((repo) => ({
  ...repo,
  path: `/projects/${repo.displayName}`,
  badgeColor: '#737373',
  addedAt: 1
}))

const seeds: WorkspaceSeed[] = [
  { id: 'orca-main', name: 'main', agents: [] },
  {
    id: 'orca-colors',
    name: 'project-group-colors',
    agents: [
      {
        agentType: 'codex',
        state: 'working',
        minutesAgo: 3,
        toolName: 'Edit',
        toolInput: 'ProjectGroupBackgrounds.tsx'
      }
    ]
  },
  { id: 'api-main', name: 'main', agents: [] },
  { id: 'quest-main', name: 'main', agents: [] },
  {
    id: 'quest-alerts',
    name: 'market-watcher',
    agents: [
      { agentType: 'claude', state: 'done', minutesAgo: 12, message: 'Updated the market alerts' }
    ]
  },
  { id: 'docs-main', name: 'main', agents: [] }
]

function setup(colored: boolean): void {
  const now = Date.now()
  seedWorkspaces(seeds, now)
  useAppStore.setState({
    repos,
    projectGroups: groups.map((group) => ({ ...group, color: colored ? group.color : null })),
    groupBy: 'repo',
    projectOrderBy: 'manual',
    sortBy: 'manual',
    activeWorktreeId: 'orca-colors',
    activeWorkspaceExecutionHostId: 'local',
    collapsedGroups: new Set([getProjectGroupHeaderKey('archive')]),
    worktreesByRepo: Object.fromEntries(
      repos.map((repo) => [
        repo.id,
        seeds
          .filter((seed) => seed.id.startsWith(repo.id.replace('repo-', '')))
          .map((seed) => ({
            ...makeWorktree(seed, now),
            repoId: repo.id,
            path: `${repo.path}/${seed.id}`
          }))
      ])
    )
  })
  window.api.projectGroups = {
    ...window.api.projectGroups,
    update: async ({ groupId, updates }) => {
      const group = useAppStore.getState().projectGroups.find((entry) => entry.id === groupId)
      return group
        ? {
            ...group,
            ...updates,
            rootProjectOrder: updates.rootProjectOrder ?? group.rootProjectOrder
          }
        : null
    }
  }
}

function SidebarPreview(): React.JSX.Element {
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  return (
    <div className="flex h-[600px] flex-col bg-worktree-sidebar text-sidebar-foreground">
      <div className="px-3 py-2 text-xs text-muted-foreground">Projects</div>
      <ConfirmationDialogProvider>
        <WorktreeList scrollOffsetRef={scrollOffsetRef} scrollAnchorRef={scrollAnchorRef} />
      </ConfirmationDialogProvider>
    </div>
  )
}

export const uncolored = defineFixture({
  width: 360,
  setup: () => setup(false),
  render: () => <SidebarPreview />
})
export const colored = defineFixture({
  width: 360,
  setup: () => setup(true),
  render: () => <SidebarPreview />
})
