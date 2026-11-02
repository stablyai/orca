// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import type { WorkItemsCacheSources } from '@/store/github/cache-model'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from '../../../../shared/github/work-items-query-bounds'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { getGitHubTaskKind } from '../../../../shared/task-github-search'
import type { TaskProvider } from '../../../../shared/task-providers'
import { parseTaskQuery } from '../../../../shared/task-query'
import { getTaskPageRepoCacheRows } from './task-page-cache-selectors'
import type * as CacheSelectors from './task-page-cache-selectors'
import { getTaskPageRepoCacheInput, getTaskPageRepoSourceContext } from './task-page-source-context'
import { getSourceOptions } from './task-page-localized-options'
import { useTaskPageStoreBindings } from './use-task-page-store-bindings'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'
import { useTaskPageRuntimeHosts } from './use-task-page-runtime-hosts'
import { useTaskPageSourceAvailability } from './use-task-page-source-availability'
import { useTaskPageProviderState } from './use-task-page-provider-state'
import { useTaskPageGitHubListState } from './github/use-task-page-github-list-state'
import { useTaskPageGitHubDetail } from './github/use-task-page-github-detail'
import { useTaskPageGitHubCacheReconciliation } from './github/use-task-page-github-cache-reconciliation'
import { useTaskPageSourceDisplay } from './use-task-page-source-display'
import { TaskPageGitHubFilters } from './github/Filters'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))
// Count the source reader's own cache reads; writers keep the uninstrumented cache.
const readerWork = vi.hoisted(() => ({ invocations: 0, gets: 0, enumerations: 0 }))
vi.mock('./task-page-cache-selectors', async (importOriginal) => {
  const actual = await importOriginal<typeof CacheSelectors>()
  return {
    ...actual,
    createTaskPageWorkItemsCacheSelector: (
      ...args: Parameters<typeof actual.createTaskPageWorkItemsCacheSelector>
    ) => {
      const select = actual.createTaskPageWorkItemsCacheSelector(...args)
      return (cache: Parameters<typeof select>[0]) => {
        readerWork.invocations += 1
        return select(
          new Proxy(cache, {
            get: (target, key, receiver) => {
              readerWork.gets += 1
              return Reflect.get(target, key, receiver)
            },
            ownKeys: (target) => {
              readerWork.enumerations += 1
              return Reflect.ownKeys(target)
            }
          })
        )
      }
    }
  }
})

const Q1 = 'is:issue is:open'
const Q2 = 'is:issue label:bug'
const upstream = { owner: 'upstream-owner', repo: 'project' }
const fork = { owner: 'fork-owner', repo: 'project', host: 'ghe.example.com' }
const sources = (issues: GitHubOwnerRepo | null, prs = issues): WorkItemsCacheSources => ({
  issues,
  prs,
  originCandidate: fork,
  upstreamCandidate: upstream
})
// Saved project identity is the upstream; the list's resolved source can differ.
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local',
  upstream
}
const sshTwin: Repo = {
  ...repo,
  path: '/ssh/repo',
  connectionId: 'box',
  executionHostId: 'ssh:box'
}

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
// listWorkItems answers by repo path and query; a missing answer fails the fetch.
let listAnswers: Map<string, WorkItemsCacheSources>
const setIssueSourcePreference = vi.fn()

function useMountedSourceDisplay() {
  const store = useTaskPageStoreBindings()
  const selection = useTaskPageRepoSelection(store)
  const hosts = useTaskPageRuntimeHosts(selection)
  const availability = useTaskPageSourceAvailability(hosts)
  const provider = useTaskPageProviderState(availability)
  const list = useTaskPageGitHubListState(provider)
  const detail = useTaskPageGitHubDetail(list)
  const reconciled = useTaskPageGitHubCacheReconciliation(detail)
  // Stage 21 derives the kind the same way before handing off to the source display.
  return useTaskPageSourceDisplay(
    Object.assign(reconciled, {
      activeGithubTaskKind: getGitHubTaskKind(
        reconciled.activeTaskPreset,
        reconciled.appliedTaskSearch
      )
    })
  )
}
let view: ReturnType<typeof useMountedSourceDisplay>
function Harness() {
  view = useMountedSourceDisplay()
  return (
    <TooltipProvider>
      <TaskPageGitHubFilters
        model={
          {
            ...view,
            setIssueSourcePreference,
            appliedTaskQuery: parseTaskQuery(view.appliedTaskSearch),
            loadedGitHubAuthorLogins: [],
            primaryGithubFilterSlug: null,
            githubTasksBusy: false,
            newIssueTargetRepo: null
          } as unknown as TaskPageComposerActionsModel
        }
      />
    </TooltipProvider>
  )
}

function mount(repos: Repo[], query = Q1) {
  useAppStore.setState({
    repos,
    settings: createGlobalSettingsFixture({
      defaultRepoSelection: [...new Set(repos.map((r) => r.id))]
    }),
    taskPageData: { taskSource: 'github' }
  })
  const mounted = render(<Harness />)
  applyQuery(query)
  return mounted
}
function applyQuery(query: string) {
  act(() => view.setAppliedTaskSearch(query))
}
async function fetchList(row: Repo, query: string, answer?: WorkItemsCacheSources) {
  if (answer) {
    listAnswers.set(`${row.path}\0${query}`, answer)
  }
  await act(async () => {
    await useAppStore
      .getState()
      .fetchWorkItems(row.id, row.path, view.githubPerRepoPageLimit, query, {
        force: true,
        sourceContext: getTaskPageRepoSourceContext(row, 'github')
      })
      .catch(() => [])
  })
}
function sourceRowCount() {
  return screen.queryAllByRole('group', { name: 'Issue source' }).length
}
// Summary, single-repo link and Filters source row must make the same claim.
function expectSurfaces(source: (GitHubOwnerRepo & { host?: string }) | null) {
  const { taskSourceContextSummary: summary, selectedGitHubRepoExternalLink: link } = view
  if (!source) {
    expect(summary.label).toMatch(/Selected project$/)
    expect(summary.title).not.toMatch(/Source:/)
    expect(link).toBeNull()
    expect(sourceRowCount()).toBe(0)
    return
  }
  const slug = `${source.owner}/${source.repo}`
  expect(summary.label).toMatch(new RegExp(`${slug}$`))
  expect(summary.title).toContain(`Source: ${slug}`)
  expect(link).toEqual({ url: `https://${source.host ?? 'github.com'}/${slug}`, label: slug })
  expect(sourceRowCount()).toBe(1)
}

beforeEach(() => {
  listAnswers = new Map()
  setIssueSourcePreference.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        viewer: vi.fn().mockResolvedValue(null),
        listWorkItems: vi.fn(async ({ repoPath, query = '' }) => {
          const answer = listAnswers.get(`${repoPath}\0${query}`)
          if (!answer) {
            throw new Error('list failed')
          }
          return { items: [], sources: answer }
        })
      },
      repos: { update: vi.fn(async ({ repoId }) => ({ ...repo, id: repoId })) },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
  useAppStore.setState({ ...initialStore, workItemsCache: {} }, true)
})
afterEach(async () => {
  await i18n.changeLanguage('en')
  cleanup()
  useAppStore.setState(initialStore, true)
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('Tasks source display', () => {
  it('carries the last shown entry across a query change, live, until a current entry or eviction', async () => {
    mount([repo])
    await fetchList(repo, Q1, sources(fork))
    expectSurfaces(fork)

    applyQuery(Q2)
    expectSurfaces(fork)
    // Notices and Retry still read only the current query's entry.
    expect(view.perRepoSourceState[0].sources).toBeNull()
    expect(view.unresolvedSourceRepos).toEqual([])

    // The shown entry is read live: an unchanged refresh keeps it, a changed one is followed.
    await fetchList(repo, Q1)
    expectSurfaces(fork)
    await fetchList(repo, Q1, sources(upstream))
    expectSurfaces(upstream)
    // Another query's result never takes over the display.
    await fetchList(repo, 'is:issue is:closed', sources(fork))
    expectSurfaces(upstream)

    await fetchList(repo, Q2, sources(fork))
    expectSurfaces(fork)
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expect(setIssueSourcePreference).toHaveBeenCalledWith('repo', '/repo', 'origin', 'local')

    // A real preference change evicts the row's entries while Filters stays mounted.
    applyQuery('is:issue is:closed sort:updated')
    expectSurfaces(fork)
    await act(() =>
      useAppStore.getState().setIssueSourcePreference('repo', '/repo', 'upstream', 'local')
    )
    expectSurfaces(null)
    await fetchList(repo, 'is:issue is:closed sort:updated', sources(upstream))
    expectSurfaces(upstream)
  })

  it('keeps a failed query on the last source, but an unresolved or too-large query claims none', async () => {
    mount([repo])
    await fetchList(repo, Q1, sources(fork))
    applyQuery(Q2)
    await fetchList(repo, Q2)
    expectSurfaces(fork)

    const tooLarge = 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES + 1)
    applyQuery(tooLarge)
    expectSurfaces(null)
    applyQuery(Q2)
    expectSurfaces(fork)

    // A present unresolved entry wins, and stays the row's shown entry on the next query.
    await fetchList(repo, Q2, { ...sources(null), originCandidate: null, upstreamCandidate: null })
    expectSurfaces(null)
    applyQuery('is:issue is:closed')
    expectSurfaces(null)

    // The active kind never borrows the other kind's source.
    await fetchList(repo, 'is:issue is:closed', sources(null, fork))
    expect(view.taskSourceContextSummary.title).not.toMatch(/Source:/)
    expect(view.selectedGitHubRepoExternalLink).toBeNull()
  })

  it('keeps each host copy and selected row on its own history', async () => {
    mount([repo, sshTwin])
    await fetchList(repo, Q1, sources(fork))
    applyQuery(Q2)
    expect(view.githubSourceDisplayState.map((state) => state.sources?.issues ?? null)).toEqual([
      fork,
      null
    ])
    expect(sourceRowCount()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expect(setIssueSourcePreference).toHaveBeenCalledWith('repo', '/repo', 'origin', 'local')

    // A row that leaves the selection forgets its history.
    act(() => view.setRepoSelection(new Set()))
    act(() => view.setRepoSelection(new Set(['repo'])))
    expect(view.githubSourceDisplayState.map((state) => state.sources)).toEqual([null, null])
  })

  it('re-translates the mounted summary when the language changes', async () => {
    const mounted = mount([repo])
    await fetchList(repo, Q1, sources(fork))
    await act(() => i18n.changeLanguage('es'))
    mounted.rerender(<Harness />)
    expect(view.taskSourceContextSummary.title).toContain('Fuente: fork-owner/project')
  })

  it('keeps Projects, GitLab, Linear and Jira summaries', () => {
    const summary = (args: {
      taskSource: TaskProvider
      githubMode?: 'items' | 'project'
      selectedLinearWorkspace?: { id: string; organizationName: string }
      selectedJiraSite?: { id: string; displayName: string }
    }) =>
      renderHook(() =>
        useTaskPageSourceDisplay({
          githubMode: 'items',
          sourceOptions: getSourceOptions(),
          selectedRepos: [repo],
          perRepoSourceState: [],
          githubSourceDisplayState: [],
          taskSourceRepoContexts:
            args.taskSource === 'gitlab' ? [getTaskPageRepoSourceContext(repo, 'gitlab')] : [],
          taskSourceHostAvailability: [],
          accountBackedTaskSourceHostId: 'local',
          accountBackedTaskSourceHostAvailability: [],
          hostRegistryById: new Map(),
          hostLabelById: new Map(),
          selectedLinearWorkspace: null,
          selectedJiraSite: null,
          activeGithubTaskKind: 'issues',
          ...args
        } as unknown as Parameters<typeof useTaskPageSourceDisplay>[0])
      ).result.current.taskSourceContextSummary

    expect(summary({ taskSource: 'github', githubMode: 'project' }).label).toMatch(
      /^GitHub · .+ · Current account$/
    )
    const gitlab = summary({ taskSource: 'gitlab' })
    expect(gitlab.label).toMatch(/^GitLab · .+ · Selected project$/)
    expect(gitlab.title).not.toMatch(/Source:/)
    expect(
      summary({
        taskSource: 'linear',
        selectedLinearWorkspace: { id: 'ws', organizationName: 'Acme' }
      }).label
    ).toMatch(/^Linear · .+ · Acme$/)
    expect(
      summary({ taskSource: 'jira', selectedJiraSite: { id: 'site', displayName: 'Acme Jira' } })
        .label
    ).toMatch(/^Jira · .+ · Acme Jira$/)
  })
})

describe('Tasks source display scaling', () => {
  // C cache entries in total: one carried Q1 entry per selected row, the rest another host's rows.
  async function measure(selectedCount: number, cacheSize: number) {
    const rows = Array.from({ length: selectedCount }, (_, index) => ({
      ...repo,
      id: `repo-${index}`,
      path: `/repo-${index}`,
      upstream: { owner: 'upstream-owner', repo: `project-${index}` }
    }))
    const other: Repo = {
      ...sshTwin,
      id: 'other',
      path: '/other',
      upstream: { owner: 'o', repo: 'other' }
    }
    mount(rows)
    for (const row of rows) {
      await fetchList(row, Q1, sources(fork))
    }
    const otherContext = getTaskPageRepoSourceContext(other, 'github')
    const fillerKeys = getTaskPageRepoCacheRows(
      Array.from({ length: cacheSize - selectedCount }, () => getTaskPageRepoCacheInput(other)),
      view.githubPerRepoPageLimit,
      ''
    ).map((row, index) => `${row.cacheKey}filler-${index}`)
    useAppStore.setState((s) => ({
      workItemsCache: {
        ...s.workItemsCache,
        ...Object.fromEntries(
          fillerKeys.map((key) => [
            key,
            {
              data: [{ id: 'issue-1', repoId: 'other', title: 'x' }],
              fetchedAt: 1,
              sources: sources(fork)
            }
          ])
        )
      }
    }))
    applyQuery(Q2)
    expect(view.githubSourceDisplayState.every((state) => state.sources?.issues === fork)).toBe(
      true
    )
    readerWork.invocations = 0
    readerWork.gets = 0
    readerWork.enumerations = 0
    // Real cache writes: another host's patch, then a current-query and a sibling fetch.
    act(() =>
      useAppStore
        .getState()
        .patchWorkItem('issue-1', { title: 'y' }, 'other', { sourceContext: otherContext })
    )
    await fetchList(rows[0], Q2, sources(fork))
    await fetchList(rows[0], 'is:issue is:closed', sources(upstream))
    const work = { ...readerWork }
    cleanup()
    useAppStore.setState({ workItemsCache: {} })
    return work
  }

  it('reads at most two cache entries per selected row per selection, never scanning the cache', async () => {
    const small = await measure(10, 500)
    const large = await measure(100, 500)
    const smallCache = await measure(10, 50)
    for (const work of [small, large, smallCache]) {
      expect(work.enumerations).toBe(0)
      expect(work.invocations).toBeGreaterThan(0)
    }
    const perSelection = (work: typeof small) => work.gets / work.invocations
    expect(perSelection(small)).toBeLessThanOrEqual(2 * 10)
    expect(perSelection(large)).toBeLessThanOrEqual(2 * 100)
    // Work follows selected rows, not cache size.
    expect(perSelection(smallCache)).toBe(perSelection(small))
  })
})
