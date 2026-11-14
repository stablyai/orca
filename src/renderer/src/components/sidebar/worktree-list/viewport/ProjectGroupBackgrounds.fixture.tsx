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

function setup(colored: boolean, hierarchy = false): void {
  const now = Date.now()
  const fixtureGroups = hierarchy
    ? [
        groups[0],
        { ...groups[0], id: 'tooling', name: 'Tooling', color: null, parentGroupId: 'work' },
        { ...groups[1], createdFrom: 'folder-scan' as const, parentPath: '/projects/personal' },
        groups[2]
      ]
    : groups
  const fixtureRepos = hierarchy
    ? repos.map((repo) => (repo.id === 'repo-api' ? { ...repo, projectGroupId: 'tooling' } : repo))
    : repos
  const fixtureSeeds: WorkspaceSeed[] = hierarchy
    ? [...seeds, { id: 'orca-guides', name: 'nesting-guides', agents: [] }]
    : seeds
  seedWorkspaces(fixtureSeeds, now)
  useAppStore.setState({
    repos: fixtureRepos,
    projectGroups: fixtureGroups.map((group) => ({
      ...group,
      color: colored ? group.color : null
    })),
    groupBy: 'repo',
    projectOrderBy: 'manual',
    sortBy: 'manual',
    activeWorktreeId: 'orca-colors',
    activeWorkspaceExecutionHostId: 'local',
    collapsedGroups: new Set([getProjectGroupHeaderKey('archive')]),
    worktreeLineageById: hierarchy
      ? {
          'orca-guides': {
            worktreeId: 'orca-guides',
            worktreeInstanceId: 'orca-guides-instance',
            parentWorktreeId: 'orca-colors',
            parentWorktreeInstanceId: 'orca-colors-instance',
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: now
          }
        }
      : {},
    folderWorkspaces: hierarchy
      ? [
          {
            id: 'personal-notes',
            projectGroupId: 'personal',
            name: 'Notes',
            folderPath: '/projects/personal/notes',
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: now,
            createdAt: now,
            updatedAt: now
          }
        ]
      : [],
    worktreesByRepo: Object.fromEntries(
      fixtureRepos.map((repo) => [
        repo.id,
        fixtureSeeds
          .filter((seed) => seed.id.startsWith(repo.id.replace('repo-', '')))
          .map((seed, index) => ({
            ...makeWorktree(seed, now),
            instanceId: `${seed.id}-instance`,
            sortOrder: index,
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
export const hierarchy = defineFixture({
  width: 360,
  setup: () => setup(true, true),
  render: () => <SidebarPreview />
})
export const notices = defineFixture({
  width: 360,
  setup: () => {
    setup(true)
    useAppStore.setState({
      activePendingCreationId: 'fixture-pending',
      pendingWorktreeCreations: {
        'fixture-pending': {
          creationId: 'fixture-pending',
          phase: 'creating',
          status: 'creating',
          startedAt: Date.now(),
          indeterminate: true,
          loaderVisible: true,
          request: {
            repoId: 'repo-orca',
            name: 'creating-feature',
            setupDecision: 'inherit',
            agent: null,
            pendingFirstAgentMessageRename: false,
            note: '',
            startupPlan: null,
            quickPrompt: '',
            quickTelemetry: null
          }
        }
      }
    })
  },
  render: () => <SidebarPreview />
})
