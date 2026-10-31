// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import { useAppStore } from '../store'
import {
  getProjectGroupingModelFromState,
  getProjectGroupingIndexFromState
} from '../store/project-host-setup-selector'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { buildSettingsProjectList } from './settings/settings-project-list'
import { buildNewWorkspaceProjectOptions } from '../lib/new-workspace-project-options'
import { useProjectFilterOptions } from './sidebar/use-project-filter-options'
import { useRecentProjectIds } from './new-workspace/use-recent-project-ids'
import { groupResumeWorkspacesByRepo } from './native-chat-resume-on-restart-grouping'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

it.each([100, 1000])(
  'bounds actual collection and mounted filter/recents work for %i repositories',
  (count) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    let reads = 0
    const repos: Repo[] = Array.from({ length: count }, (_, project) =>
      (['local', 'runtime:server'] as const).map((executionHostId) => ({
        get id() {
          reads++
          return `repo-${project}-${executionHostId}`
        },
        path: `/repos/${project}`,
        displayName: `App ${project}`,
        badgeColor: '',
        addedAt: 0,
        executionHostId,
        upstream: { owner: 'org', repo: `app-${project}` }
      }))
    ).flat()
    const worktrees = repos.flatMap((repo) =>
      Array.from({ length: 3 }, (_, row) =>
        makeWorktree({
          id: `${repo.id}::${row}`,
          repoId: repo.id,
          hostId: repo.executionHostId ?? undefined,
          createdAt: row
        })
      )
    )
    const settings = getDefaultSettings('/tmp')
    const projection = projectHostSetupProjectionFromRepos(repos)
    const projects = projection.projects.map((project) => ({
      ...project,
      get id() {
        reads++
        return project.id
      }
    }))
    useAppStore.setState({
      repos,
      projects,
      projectHostSetups: projection.setups,
      worktreesByRepo: Object.fromEntries(
        repos.map((repo, i) => [repo.id, worktrees.slice(i * 3, i * 3 + 3)])
      ),
      settings
    })
    const state = useAppStore.getState()
    const model = getProjectGroupingModelFromState(state)
    const grouping = getProjectGroupingIndexFromState(state)
    reads = 0
    expect(buildSettingsProjectList(repos, model)).toHaveLength(count)
    expect(reads).toBeLessThan(100 * count)
    reads = 0
    expect(
      buildNewWorkspaceProjectOptions({
        projects: model.projects,
        projectHostSetups: model.projectHostSetups,
        eligibleRepos: repos,
        grouping
      })
    ).toHaveLength(count)
    expect(reads).toBeLessThan(100 * count)
    const repoByWorkspace = new Map(worktrees.map((worktree) => [worktree.id, worktree.repoId]))
    const offers = worktrees.map((worktree) => ({
      workspaceId: worktree.id,
      candidates: [
        {
          sessionId: worktree.id,
          workspaceId: worktree.id,
          agent: 'codex' as const,
          trigger: 'quit' as const,
          latestPrompt: '',
          recordedAt: 0,
          executionHostId: worktree.hostId ?? 'local'
        }
      ]
    }))
    reads = 0
    expect(
      groupResumeWorkspacesByRepo(
        offers,
        (id) => repoByWorkspace.get(id) ?? null,
        repos,
        undefined,
        grouping
      )
    ).toHaveLength(count)
    expect(reads).toBeLessThan(100 * count)

    const filter = [repos[0].id]
    let renders = 0
    function Consumer() {
      renders++
      const options = useProjectFilterOptions(filter)
      const recent = useRecentProjectIds()
      return (
        <output>
          {options.repos.length}:{options.selection.matchingKeys.length}:
          {recent.filter((id) => id.startsWith('project:')).length}
        </output>
      )
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      reads = 0
      act(() => root.render(<Consumer />))
      expect(container.textContent).toBe(`${count}:1:${count}`)
      expect(reads).toBeLessThan(100 * count)
      reads = 0
      const settledRenders = renders
      act(() => useAppStore.setState({ activeRepoId: 'unrelated' }))
      expect(renders).toBe(settledRenders)
      expect(reads).toBe(0)
      act(() =>
        useAppStore.setState({
          settings: {
            ...settings,
            terminalFontSize: 19,
            projectGroupingOverrides: { ...settings.projectGroupingOverrides }
          }
        })
      )
      expect(renders).toBe(settledRenders)
      expect(reads).toBe(0)
      act(() =>
        useAppStore.setState({ sshTargetLabels: new Map([['unrelated-host', 'Other host']]) })
      )
      expect(renders).toBe(settledRenders)
      expect(reads).toBe(0)
      act(() => useAppStore.setState({ settings: { ...settings, projectGroupingMode: 'host' } }))
      expect(container.textContent).toBe(`${2 * count}:1:${2 * count}`)
      expect(reads).toBeLessThan(100 * count)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
)
