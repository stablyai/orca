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
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
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
// Count the source reader's own work at its boundary; writers keep the uninstrumented cache.
const readerWork = vi.hoisted(() => ({
  invocations: 0,
  gets: 0,
  maxGetsPerInvocation: 0,
  enumerations: 0,
  keyCompositions: 0,
  rowVisits: 0
}))
function isArrayMember<T>(
  rows: T[],
  key: string | symbol
): key is Extract<keyof T[], string | symbol> {
  return key in rows
}
vi.mock('./task-page-cache-selectors', async (importOriginal) => {
  const actual = await importOriginal<typeof CacheSelectors>()
  return {
    ...actual,
    // Rows hold the composed cache keys; the selector and the after-commit pointer upkeep both walk them.
    getTaskPageRepoCacheRows: (...args: Parameters<typeof actual.getTaskPageRepoCacheRows>) => {
      readerWork.keyCompositions += 1
      return new Proxy(actual.getTaskPageRepoCacheRows(...args), {
        get: (target, key) => {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            readerWork.rowVisits += 1
            return target[Number(key)]
          }
          // Array members (length, map, entries, the iterator) pass through untouched.
          return isArrayMember(target, key) ? target[key] : undefined
        }
      })
    },
    createTaskPageWorkItemsCacheSelector: (
      ...args: Parameters<typeof actual.createTaskPageWorkItemsCacheSelector>
    ) => {
      const select = actual.createTaskPageWorkItemsCacheSelector(...args)
      return (cache: Parameters<typeof select>[0]) => {
        let gets = 0
        const selection = select(
          new Proxy(cache, {
            get: (target, key) => {
              gets += 1
              // Cache keys are strings; the reader never reads symbol keys.
              return typeof key === 'string' ? target[key] : undefined
            },
            ownKeys: (target) => {
              readerWork.enumerations += 1
              return Reflect.ownKeys(target)
            }
          })
        )
        readerWork.invocations += 1
        readerWork.gets += gets
        readerWork.maxGetsPerInvocation = Math.max(readerWork.maxGetsPerInvocation, gets)
        return selection
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
  const withKind = Object.assign(reconciled, {
    activeGithubTaskKind: getGitHubTaskKind(
      reconciled.activeTaskPreset,
      reconciled.appliedTaskSearch
    )
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field the source display reads comes from stages 1-8 or the kind above; stages 9-20 add none of them.
  const sourceDisplayInput = withKind as unknown as typeof withKind &
    Parameters<typeof useTaskPageSourceDisplay>[0]
  return useTaskPageSourceDisplay(sourceDisplayInput)
}
let view: ReturnType<typeof useMountedSourceDisplay>
function Harness() {
  view = useMountedSourceDisplay()
  const filtersFields = {
    ...view,
    setIssueSourcePreference,
    appliedTaskQuery: parseTaskQuery(view.appliedTaskSearch),
    loadedGitHubAuthorLogins: [],
    primaryGithubFilterSlug: null,
    githubTasksBusy: false,
    newIssueTargetRepo: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mounted stage-8 model plus these stubs cover every field Filters reads; later-stage handlers are never fired here.
  const filtersModel = filtersFields as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <TaskPageGitHubFilters model={filtersModel} />
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
    }) => {
      const fields = {
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
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source display reads only these model fields; the rest of the stage-20 model is unused by it.
      const model = fields as unknown as Parameters<typeof useTaskPageSourceDisplay>[0]
      return renderHook(() => useTaskPageSourceDisplay(model)).result.current
        .taskSourceContextSummary
    }

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
  type Work = typeof readerWork
  // One settled act turn per actual update, measured on its own.
  async function measureUpdate(update: () => unknown): Promise<Work> {
    Object.assign(readerWork, {
      invocations: 0,
      gets: 0,
      maxGetsPerInvocation: 0,
      enumerations: 0,
      keyCompositions: 0,
      rowVisits: 0
    })
    await act(async () => {
      await update()
    })
    return { ...readerWork }
  }
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
    window.api.repos.update = vi.fn(async ({ repoId, updates }) => ({
      ...rows.find((row) => row.id === repoId)!,
      ...updates
    }))
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
    const otherHostItem: GitHubWorkItem = {
      id: 'issue-1',
      type: 'issue',
      number: 1,
      title: 'x',
      state: 'open',
      url: 'https://github.com/o/other/issues/1',
      labels: [],
      updatedAt: '2026-01-01T00:00:00Z',
      author: null,
      repoId: 'other'
    }
    useAppStore.setState((s) => ({
      workItemsCache: {
        ...s.workItemsCache,
        ...Object.fromEntries(
          fillerKeys.map((key) => [
            key,
            {
              data: [otherHostItem],
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
    const outputs = () => [
      view.githubSourceDisplayState,
      view.selectedWorkItemsCacheEntries,
      view.sourceDisplayWorkItemsCacheEntries
    ]
    const expectOutputsReused = (before: unknown[]) =>
      outputs().forEach((output, index) => expect(output).toBe(before[index]))

    let before = outputs()
    const otherHostPatch = await measureUpdate(() =>
      useAppStore
        .getState()
        .patchWorkItem('issue-1', { title: 'y' }, 'other', { sourceContext: otherContext })
    )
    expectOutputsReused(before)
    before = outputs()
    const nonCacheWrite = await measureUpdate(() =>
      useAppStore.getState().setRightSidebarWidth(321)
    )
    expectOutputsReused(before)
    listAnswers.set(`${rows[0].path}\0${Q2}`, sources(fork))
    const currentFetch = await measureUpdate(() =>
      useAppStore
        .getState()
        .fetchWorkItems(rows[0].id, rows[0].path, view.githubPerRepoPageLimit, Q2, {
          force: true,
          sourceContext: getTaskPageRepoSourceContext(rows[0], 'github')
        })
    )
    listAnswers.set(`${rows[0].path}\0is:issue is:closed`, sources(upstream))
    const siblingFetch = await measureUpdate(() => {
      return useAppStore
        .getState()
        .fetchWorkItems(
          rows[0].id,
          rows[0].path,
          view.githubPerRepoPageLimit,
          'is:issue is:closed',
          {
            force: true,
            sourceContext: getTaskPageRepoSourceContext(rows[0], 'github')
          }
        )
    })
    const preferenceEviction = await measureUpdate(() =>
      useAppStore.getState().setIssueSourcePreference(rows[0].id, rows[0].path, 'origin', 'local')
    )
    cleanup()
    useAppStore.setState({ workItemsCache: {} })
    return { otherHostPatch, nonCacheWrite, currentFetch, siblingFetch, preferenceEviction }
  }

  // Selector calls per update (a literal, not measured): each store write notifies the subscription and the
  // renders it causes read the snapshot again. The busiest update, preference eviction, makes three writes
  // (optimistic repo patch, saved repo row, cache eviction) and measures 15.
  const MAX_SELECTIONS_PER_UPDATE = 16
  // A selector call visits each row at most twice (current key, then source key for a missing row); the
  // after-commit pointer upkeep walks rows once per commit. Its prune loop is bounded by the previous N.
  const MAX_ROW_VISITS_PER_ROW = 3 * MAX_SELECTIONS_PER_UPDATE
  it('bounds each update by selected rows, never by the cache, and never scans or rebuilds keys', async () => {
    const sizes = [
      { rows: 10, work: await measure(10, 500) },
      { rows: 100, work: await measure(100, 500) },
      { rows: 10, work: await measure(10, 50) }
    ]
    for (const { rows, work } of sizes) {
      for (const [update, counts] of Object.entries(work)) {
        expect({ update, enumerations: counts.enumerations }).toEqual({ update, enumerations: 0 })
        expect(counts.invocations).toBeGreaterThan(0)
        expect(counts.invocations).toBeLessThanOrEqual(MAX_SELECTIONS_PER_UPDATE)
        expect(counts.maxGetsPerInvocation).toBeLessThanOrEqual(2 * rows)
        expect(counts.gets).toBeLessThanOrEqual(MAX_SELECTIONS_PER_UPDATE * 2 * rows)
        expect(counts.rowVisits).toBeLessThanOrEqual(MAX_ROW_VISITS_PER_ROW * rows)
        // Keys are never rebuilt on a cache write; the preference action replaces the repos array twice.
        expect(counts.keyCompositions).toBeLessThanOrEqual(update === 'preferenceEviction' ? 2 : 0)
      }
    }
    const [small, large, smallCache] = sizes.map(({ work }) => work)
    const updates: (keyof typeof small)[] = [
      'otherHostPatch',
      'nonCacheWrite',
      'currentFetch',
      'siblingFetch',
      'preferenceEviction'
    ]
    expect(updates).toEqual(Object.keys(small))
    for (const update of updates) {
      // Selector calls grow with neither rows nor cache size.
      expect(large[update].invocations).toBe(small[update].invocations)
      // Same rows, a tenth of the cache: identical work.
      expect(smallCache[update]).toEqual(small[update])
    }
  })
})
