import { afterEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { makeTab, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { ProjectGroup } from '../../../shared/project-group-types'
import * as groups from '../../../shared/project-groups'
import * as folderHost from '../../../shared/folder-workspace-execution-host'
import * as routing from '@/store/terminals/terminal-workspace-routing'
import * as signals from './tab-agent-exit-signals'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'

const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
})
function counted<T, K extends keyof T>(row: T, key: K, count: () => void): T {
  const value = row[key]
  Object.defineProperty(row, key, {
    enumerable: true,
    get() {
      count()
      return value
    }
  })
  return row
}
it.each([10, 100])(
  'accounts separately for folder search, subtree and repo residuals at %s',
  (size) => {
    const counts = { folderIds: 0, groupParents: 0, repoGroups: 0 }
    const folders = Array.from({ length: size }, (_, i) =>
      counted(
        makeFolderWorkspace({
          id: `f${i}`,
          projectGroupId: `g${i}`,
          folderPath: `/folder/${i}`,
          executionHostId: undefined
        }),
        'id',
        () => counts.folderIds++
      )
    )
    const projectGroups: ProjectGroup[] = Array.from({ length: size }, (_, i) =>
      counted(
        {
          id: `g${i}`,
          name: `group ${i}`,
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual' as const,
          tabOrder: i,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        },
        'parentGroupId',
        () => counts.groupParents++
      )
    )
    const repos = Array.from({ length: size }, (_, i) =>
      counted(
        {
          ...TEST_REPO,
          id: `r${i}`,
          projectGroupId: `g${i}`,
          path: `/folder/${i}/repo`
        },
        'projectGroupId',
        () => counts.repoGroups++
      )
    )
    const store = createStore(createAppState)
    store.setState({
      folderWorkspaces: folders,
      projectGroups,
      repos,
      tabsByWorktree: Object.fromEntries(
        folders.map((folder, i) => {
          const workspace = folderWorkspaceKey(folder.id)
          return [
            workspace,
            [makeTab({ id: `t${i}`, worktreeId: workspace, ptyId: `pty${i}`, title: 'zsh' })]
          ]
        })
      )
    })
    const candidates = vi.spyOn(folderHost, 'resolveFolderWorkspaceHost')
    const subtrees = vi.spyOn(groups, 'getProjectGroupSubtreeIds')
    const route = vi.spyOn(routing, 'worktreeUsesRemoteConnection')
    const observation = vi.spyOn(signals, 'tabAgentExitSignals')
    const reset = () => {
      Object.assign(counts, { folderIds: 0, groupParents: 0, repoGroups: 0 })
      candidates.mockClear()
      subtrees.mockClear()
      route.mockClear()
      observation.mockClear()
    }
    reset()
    stops.push(getTabAgentExitOwner(getAgentStatusOwner(store)).start())
    expect(observation).toHaveBeenCalledTimes(size * 2)
    expect(candidates).toHaveBeenCalledTimes(size * 2)
    expect(subtrees).toHaveBeenCalledTimes(size * 2)
    expect(counts.groupParents).toBe(size * size * 2)
    expect(counts.repoGroups).toBe(size * size * 2)
    expect(counts.folderIds).toBeGreaterThanOrEqual(size * (size + 1))
    const metadata = folders.map((folder) => ({ ...folder, isUnread: true }))
    reset()
    store.setState({ folderWorkspaces: metadata })
    expect(observation).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    expect(candidates).not.toHaveBeenCalled()
    expect(subtrees).not.toHaveBeenCalled()
    expect(counts.folderIds).toBeGreaterThanOrEqual(size)
    // A genuine all-folder routing change retains the existing searches; both roots are resolved.
    reset()
    store.setState({
      projectGroups: projectGroups.map((group) => ({ ...group, connectionId: 'ssh' })),
      repos: repos.map((repo) =>
        counted(
          { ...repo, connectionId: 'ssh', executionHostId: 'ssh:ssh' as const },
          'projectGroupId',
          () => counts.repoGroups++
        )
      )
    })
    expect(observation).toHaveBeenCalledTimes(size * 2)
    expect(route).toHaveBeenCalledTimes(size * 4)
    expect(candidates).toHaveBeenCalledTimes(size * 4)
    expect(subtrees).toHaveBeenCalledTimes(size * 4)
    expect(counts.repoGroups).toBeGreaterThanOrEqual(size * size * 4)
    const remote = getTabAgentExitOwner(getAgentStatusOwner(store)).getObservation(
      folderWorkspaceKey('f0'),
      't0'
    )
    reset()
    store.setState({
      projectGroups: projectGroups.map((group) => ({ ...group, connectionId: 'other-ssh' })),
      repos: repos.map((repo) => ({
        ...repo,
        connectionId: 'other-ssh',
        executionHostId: 'ssh:other-ssh'
      }))
    })
    expect(observation).not.toHaveBeenCalled()
    expect(route).toHaveBeenCalledTimes(size * 2)
    expect(
      getTabAgentExitOwner(getAgentStatusOwner(store)).getObservation(
        folderWorkspaceKey('f0'),
        't0'
      )
    ).toBe(remote)
  }
)
