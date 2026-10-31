import { it, expect } from 'vitest'
import { useAppStore } from '../../store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
const NOW = 1_000_000_000
const worktree = (id = 'w1') => makeWorktree({ id, repoId: 'r1' })

it.each(['repository', 'host', 'folder'] as const)(
  'publishes matching workspace and Project filter identities in %s mode',
  (projectGroupingMode) => {
    const repos = [
      {
        id: 'r1',
        path: '/r1',
        displayName: 'App',
        badgeColor: '',
        addedAt: NOW,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'r2',
        path: '/r2',
        displayName: 'App',
        badgeColor: '',
        addedAt: NOW,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'r3',
        path: '/remote',
        displayName: 'App',
        badgeColor: '',
        addedAt: NOW,
        upstream: { owner: 'org', repo: 'app' },
        executionHostId: 'runtime:remote' as const
      }
    ]
    const snapshot = buildDashboardSnapshot(
      {
        ...useAppStore.getInitialState(),
        chatNames: new Map(),
        repos,
        settings: { ...getDefaultSettings('/tmp'), projectGroupingMode },
        tabsByWorktree: {},
        worktreesByRepo: {
          r1: [worktree()],
          r2: [{ ...worktree('w2'), repoId: 'r2' }],
          r3: [{ ...worktree('w3'), repoId: 'r3', hostId: 'runtime:remote' }]
        }
      },
      NOW
    )
    const workspaceKeys = new Set(snapshot.workspaces!.map((workspace) => workspace.repoId))
    expect(workspaceKeys.size).toBe(
      projectGroupingMode === 'repository' ? 1 : projectGroupingMode === 'host' ? 2 : 3
    )
    expect(new Set(snapshot.filterOptions!.projects.map((option) => option.id))).toEqual(
      workspaceKeys
    )
  }
)
