import type { ProjectHostSetupResult } from '../../../shared/project-types'
// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import { selectProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import { buildNewWorkspaceProjectOptions } from '@/lib/new-workspace-project-options'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({ default: () => null }))
vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))
let container: HTMLDivElement | null = null
afterEach(() => {
  if (container) {
    unmountCard(container)
    container = null
  }
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each(['repository', 'host', 'folder'] as const)(
  'clones the contextual second server checkout through real Project/Run-on/location controls in %s mode',
  async (mode) => {
    const local: Repo = {
      id: 'same',
      path: '/local/app',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' },
      gitRemoteIdentity: {
        canonicalKey: 'github.com/local/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/local/app.git'
      }
    }
    const server: Repo = {
      ...local,
      path: '/server/app',
      executionHostId: 'runtime:server',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/server/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/server/app.git'
      }
    }
    const second: Repo = {
      ...server,
      id: 'second',
      path: '/server/second',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/second/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/second/app.git'
      }
    }
    const repos = [local, server, second]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const clone = vi.fn().mockResolvedValue({ setup: { id: 'cloned' } })
    useAppStore.setState({
      repos,
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { ...useAppStore.getState().settings!, projectGroupingMode: mode },
      setupProjectClone: clone
    })
    const index = getProjectGroupingIndexFromState(useAppStore.getState())
    const group = index.groupByRepoHost.get('runtime:server\0second')!
    const options = buildNewWorkspaceProjectOptions({
      projects: projection.projects,
      projectHostSetups: projection.setups,
      eligibleRepos: repos,
      grouping: index
    })
    const ready = vi.fn()
    container = await renderCard({
      eligibleRepos: repos,
      projectOptions: options,
      selectedProjectId: group.key,
      repoId: second.id,
      selectedRepo: second,
      selectedRepoPath: second.path,
      selectedRepoExecutionHostId: second.executionHostId,
      projectHostSetupOptions: [
        {
          kind: 'needs-setup',
          id: 'destination',
          projectId: group.representative.projectId,
          hostId: 'runtime:destination',
          label: 'Destination',
          detail: 'Project location not set',
          isAvailable: true,
          attention: false,
          canSetLocation: true
        }
      ],
      selectedProjectHostSetupId: null,
      onProjectHostSetupChange: ready
    })
    const user = userEvent.setup()
    await user.click(container.querySelector<HTMLElement>('[data-run-target-combobox-root]')!)
    await user.click(screen.getByRole('button', { name: /Set project location/ }))
    await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
    await user.type(screen.getByPlaceholderText('/destination/on/host'), '/destination/new-app')
    await user.click(screen.getByRole('button', { name: 'Clone' }))
    expect(clone).toHaveBeenCalledExactlyOnceWith({
      projectId: group.representative.projectId,
      hostId: 'runtime:destination',
      url: 'https://github.com/second/app.git',
      destination: '/destination/new-app',
      displayName: group.label
    })
    expect(ready).toHaveBeenCalledWith(JSON.stringify(['cloned', 'runtime:destination']))
  }
)

it('re-derives an untouched restored source, preserves edits through catalog changes, and fences fresh-source/dismissed requests', async () => {
  const source: Repo = {
    id: 'same',
    path: '/server/app',
    executionHostId: 'runtime:server',
    displayName: 'App',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }
  const other: Repo = {
    ...source,
    id: 'second',
    path: '/server/second',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/second/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/second/app.git'
    }
  }
  const projection = projectHostSetupProjectionFromRepos([source, other])
  let finish!: (result: ProjectHostSetupResult) => void
  const clone = vi.fn(
    () =>
      new Promise<ProjectHostSetupResult>((resolve) => {
        finish = resolve
      })
  )
  const ready = vi.fn()
  useAppStore.setState({
    repos: [source, other],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    setupProjectClone: clone
  })
  const index = getProjectGroupingIndexFromState(useAppStore.getState())
  const group = index.groupByRepoHost.get('runtime:server\0same')!
  const options = buildNewWorkspaceProjectOptions({
    projects: projection.projects,
    projectHostSetups: projection.setups,
    eligibleRepos: [source, other],
    grouping: index
  })
  const props = {
    eligibleRepos: [source, other],
    projectOptions: options,
    selectedProjectId: group.key,
    repoId: source.id,
    selectedRepo: source,
    selectedRepoPath: source.path,
    selectedRepoExecutionHostId: source.executionHostId,
    projectHostSetupOptions: [
      {
        kind: 'needs-setup' as const,
        id: 'destination',
        projectId: group.representative.projectId,
        hostId: 'runtime:destination' as const,
        label: 'Destination',
        detail: 'Project location not set',
        isAvailable: true,
        attention: false,
        canSetLocation: true
      }
    ],
    selectedProjectHostSetupId: null,
    onProjectHostSetupChange: ready
  }
  container = await renderCard(props)
  const user = userEvent.setup()
  const open = async () => {
    await user.click(container!.querySelector<HTMLElement>('[data-run-target-combobox-root]')!)
    await user.click(screen.getByRole('button', { name: /Set project location/ }))
    await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
  }
  await open()
  const input = screen.getByPlaceholderText('Repository URL')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing URL input')
  }
  expect(input.value).toBe('')
  const hydrated = {
    ...source,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/first/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/first/app.git'
    }
  }
  act(() => useAppStore.setState({ repos: [other, hydrated] }))
  expect(input.value).toBe('https://github.com/first/app.git')
  await user.clear(input)
  await user.type(input, 'https://github.com/typed/app.git')
  act(() => useAppStore.setState({ repos: [other] }))
  expect(input.value).toBe('https://github.com/typed/app.git')
  // Same destination, new explicit source starts a fresh action rather than inheriting the abandoned draft.
  await renderCard(
    { ...props, repoId: other.id, selectedRepo: other, selectedRepoPath: other.path },
    container
  )
  await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
  const fresh = screen.getByPlaceholderText('Repository URL')
  if (!(fresh instanceof HTMLInputElement)) {
    throw new Error('Missing fresh URL input')
  }
  expect(fresh.value).toBe('https://github.com/second/app.git')
  await user.type(screen.getByPlaceholderText('/destination/on/host'), '/destination/app')
  await user.click(screen.getByRole('button', { name: 'Clone' }))
  expect(clone).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: 'https://github.com/second/app.git',
      hostId: 'runtime:destination',
      destination: '/destination/app'
    })
  )
  await user.keyboard('{Escape}')
  await act(async () =>
    finish({
      project: projection.projects[1]!,
      repo: { ...other, executionHostId: 'runtime:destination', path: '/destination/app' },
      setup: {
        ...projection.setups[1]!,
        id: 'finished-after-dismiss',
        hostId: 'runtime:destination',
        path: '/destination/app'
      }
    })
  )
  expect(ready).not.toHaveBeenCalled()
  await open()
  const reopened = screen.getByPlaceholderText('Repository URL')
  if (!(reopened instanceof HTMLInputElement)) {
    throw new Error('Missing reopened URL input')
  }
  expect(reopened.value).toBe('https://github.com/second/app.git')
})

it.each([
  [100, 100, 100, true],
  [1000, 100, 100, true],
  [100, 1000, 100, true],
  [100, 100, 1000, true],
  [1000, 1000, 1000, true],
  [100, 100, 100, false],
  [1000, 1000, 1000, false]
] as const)(
  'bounds the actual folder-source composer selector cold/warm work at P=%i R=%i S=%i raw-match=%s',
  async (p, r, s, matched) => {
    let projectReads = 0
    let repoReads = 0
    let memberReads = 0
    const ids = Array.from({ length: s }, (_, i) => `member-${i}`)
    ids[s - 1] = 'source'
    for (let i = 0; i < s; i++) {
      const id = ids[i]
      Object.defineProperty(ids, i, {
        get: () => {
          memberReads++
          return id
        }
      })
    }
    const source: Repo = {
      id: 'source',
      path: '/source',
      displayName: 'Source',
      executionHostId: 'runtime:server',
      badgeColor: '',
      addedAt: 0,
      gitRemoteIdentity: {
        canonicalKey: 'github.com/org/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/org/app.git'
      }
    }
    const repos = Array.from({ length: r }, (_, i): Repo => ({
      ...source,
      path: i === r - 1 ? source.path : `/repo-${i}`,
      get id() {
        repoReads++
        return i === r - 1 ? source.id : `repo-${i}`
      }
    }))
    const projects = Array.from({ length: p }, (_, i) => ({
      get id() {
        projectReads++
        return matched && i === p - 1 ? 'project-group:platform' : `raw-${i}`
      },
      displayName: `Raw ${i}`,
      badgeColor: '',
      sourceRepoIds: i === p - 1 ? ids : [],
      createdAt: 0,
      updatedAt: 0
    }))
    useAppStore.setState({
      repos,
      projects,
      settings: { ...useAppStore.getState().settings!, projectGroupingOverrides: {} }
    })
    getProjectGroupingIndexFromState(useAppStore.getState())
    projectReads = repoReads = memberReads = 0
    container = await renderCard({
      selectedRepo: source,
      eligibleRepos: [source],
      repoId: source.id,
      selectedRepoPath: source.path,
      selectedRepoExecutionHostId: source.executionHostId
    })
    expect(projectReads).toBe(p)
    expect(repoReads).toBeLessThanOrEqual(r + 1)
    expect(memberReads).toBe(matched ? s : 0)
    process.stdout.write(
      `PG6-B ${JSON.stringify({ p, r, s, matched, projectReads, repoReads, memberReads })}\n`
    )
    projectReads = repoReads = memberReads = 0
    act(() => useAppStore.setState({ activeRepoId: 'unrelated' }))
    expect([projectReads, repoReads, memberReads]).toEqual([0, 0, 0])
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, projectGroupingOverrides: {} }
      })
    )
    expect([projectReads, repoReads, memberReads]).toEqual([0, 0, 0])
    const user = userEvent.setup()
    await user.click(container!.querySelector<HTMLElement>('[data-run-target-combobox-root]')!)
    await user.click(screen.getByRole('button', { name: /Set project location/ }))
    await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
    expect(screen.getByPlaceholderText('Repository URL')).toHaveProperty(
      'value',
      matched ? 'https://github.com/org/app.git' : ''
    )
  }
)

it.each([100, 1000])(
  'keeps source-aware selected URL renders separate from upstream cold work at R=%i',
  (count) => {
    let repoReads = 0
    let projectReads = 0
    let renders = 0
    const source = { repoId: 'source', hostId: 'runtime:server', path: '/source' }
    const repos: Repo[] = Array.from({ length: count }, (_, i) => ({
      get id() {
        repoReads++
        return i === count - 1 ? 'source' : `other-${i}`
      },
      path: i === count - 1 ? '/source' : `/other-${i}`,
      displayName: `Repo ${i}`,
      executionHostId: i === count - 1 ? 'runtime:server' : 'runtime:other',
      badgeColor: '',
      addedAt: 0,
      gitRemoteIdentity: {
        canonicalKey: `github.com/org/app-${i}`,
        remoteName: 'origin',
        remoteUrl:
          i === count - 1 ? 'https://github.com/org/source.git' : 'https://github.com/org/other.git'
      }
    }))
    const projects = [
      {
        get id() {
          projectReads++
          return 'raw-project'
        },
        displayName: 'Raw',
        badgeColor: '',
        sourceRepoIds: ['source'],
        createdAt: 0,
        updatedAt: 0
      }
    ]
    useAppStore.setState({
      repos,
      projects,
      settings: { ...useAppStore.getState().settings!, projectGroupingOverrides: {} }
    })
    getProjectGroupingIndexFromState(useAppStore.getState())
    function Subscriber() {
      const url = useAppStore((state) => selectProjectCloneUrlPrefill(state, 'raw-project', source))
      renders++
      return <output data-testid="source-url">{url}</output>
    }
    render(<Subscriber />)
    expect(screen.getByTestId('source-url').textContent).toBe('https://github.com/org/source.git')
    repoReads = projectReads = renders = 0
    act(() => useAppStore.setState({ activeRepoId: 'unrelated' }))
    expect([repoReads, projectReads, renders]).toEqual([0, 0, 0])
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, terminalFontSize: 19 }
      })
    )
    expect([repoReads, projectReads, renders]).toEqual([0, 0, 0])
    act(() =>
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, projectGroupingOverrides: {} }
      })
    )
    expect([repoReads, projectReads, renders]).toEqual([0, 0, 0])
    act(() =>
      useAppStore.setState({
        repos: repos.map((repo, i) =>
          i === 0 ? { ...repo, displayName: 'Other host renamed' } : repo
        )
      })
    )
    expect(renders).toBe(0)
    expect(repoReads).toBeGreaterThanOrEqual(count - 1)
    expect(repoReads).toBeLessThan(100 * count)
    process.stdout.write(
      `PG6-B-subscription ${JSON.stringify({ count, otherHostColdRepoReads: repoReads, otherHostColdProjectReads: projectReads, renders })}\n`
    )
    act(() =>
      useAppStore.setState({
        repos: useAppStore.getState().repos.map((repo) =>
          repo.id === 'source'
            ? {
                ...repo,
                gitRemoteIdentity: {
                  ...repo.gitRemoteIdentity!,
                  remoteUrl: 'https://github.com/org/changed.git'
                }
              }
            : repo
        )
      })
    )
    expect(renders).toBeGreaterThan(0)
    expect(screen.getByTestId('source-url').textContent).toBe('https://github.com/org/changed.git')
    renders = 0
    act(() => useAppStore.setState({ projects: [{ ...projects[0], sourceRepoIds: [] }] }))
    expect(renders).toBeGreaterThan(0)
    expect(screen.getByTestId('source-url').textContent).toBe('')
  }
)
