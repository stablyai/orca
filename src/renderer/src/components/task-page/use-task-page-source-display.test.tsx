// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import { workItemsCacheKey } from '@/store/github/cache-identity'
import type { WorkItemsCacheSources } from '@/store/github/cache-model'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from '../../../../shared/github/work-items-query-bounds'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskProvider } from '../../../../shared/task-providers'
import { parseTaskQuery } from '../../../../shared/task-query'
import {
  buildTaskPageRepoSourceState,
  createTaskPageSourceDisplayEntriesSelector,
  selectTaskPageUnresolvedSourceRepos,
  selectTaskPageWorkItemsCacheEntries
} from './task-page-cache-selectors'
import { getTaskPageRepoCacheInput, getTaskPageRepoSourceContext } from './task-page-source-context'
import { getSourceOptions } from './task-page-localized-options'
import { useTaskPageSourceDisplay } from './use-task-page-source-display'
import { TaskPageGitHubFilters } from './github/Filters'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))

const LIMIT = 20
const upstream = { owner: 'upstream-owner', repo: 'project' }
const fork = { owner: 'fork-owner', repo: 'project', host: 'ghe.example.com' }
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
const forkSources: WorkItemsCacheSources = {
  issues: fork,
  prs: fork,
  originCandidate: fork,
  upstreamCandidate: upstream
}

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

function cacheKey(row: Repo, query: string): string {
  return workItemsCacheKey(row.id, LIMIT, query, getTaskPageRepoCacheInput(row).sourceCacheScope)
}
function cacheSources(
  entries: [row: Repo, query: string, sources: WorkItemsCacheSources, fetchedAt?: number][]
): void {
  useAppStore.setState({
    workItemsCache: Object.fromEntries(
      entries.map(([row, query, sources, fetchedAt = 1]) => [
        cacheKey(row, query),
        { data: [], fetchedAt, sources }
      ])
    )
  })
}

function sourceDisplay(args: {
  repos?: Repo[]
  query: string
  kind?: 'issues' | 'prs'
  mode?: 'items' | 'project'
  taskSource?: TaskProvider
  selectedLinearWorkspace?: { id: string; organizationName: string }
  selectedJiraSite?: { id: string; displayName: string }
}) {
  const { repos = [repo], query, kind = 'issues', mode = 'items', taskSource = 'github' } = args
  const cache = useAppStore.getState().workItemsCache
  const inputs = repos.map(getTaskPageRepoCacheInput)
  const model = {
    taskSource,
    githubMode: mode,
    sourceOptions: getSourceOptions(),
    selectedRepos: repos,
    perRepoSourceState: buildTaskPageRepoSourceState(
      inputs,
      selectTaskPageWorkItemsCacheEntries(cache, inputs, LIMIT, query)
    ),
    githubSourceDisplayState: buildTaskPageRepoSourceState(
      inputs,
      createTaskPageSourceDisplayEntriesSelector(inputs, LIMIT, query)(cache)
    ),
    taskSourceRepoContexts:
      taskSource === 'github' || taskSource === 'gitlab'
        ? repos.map((row) => getTaskPageRepoSourceContext(row, taskSource)!)
        : [],
    taskSourceHostAvailability: [],
    accountBackedTaskSourceHostId: 'local',
    accountBackedTaskSourceHostAvailability: [],
    hostRegistryById: new Map(),
    hostLabelById: new Map(),
    selectedLinearWorkspace: args.selectedLinearWorkspace ?? null,
    selectedJiraSite: args.selectedJiraSite ?? null,
    activeGithubTaskKind: kind
  } as unknown as Parameters<typeof useTaskPageSourceDisplay>[0]
  return renderHook(() => useTaskPageSourceDisplay(model)).result.current
}

function expectSourceClaim(
  display: ReturnType<typeof sourceDisplay>,
  source: (GitHubOwnerRepo & { host?: string }) | null
): void {
  const { taskSourceContextSummary: summary, selectedGitHubRepoExternalLink: link } = display
  if (!source) {
    expect(summary.label).toMatch(/Selected project$/)
    expect(summary.title).not.toMatch(/Source:/)
    expect(link).toBeNull()
    return
  }
  const slug = `${source.owner}/${source.repo}`
  expect(summary.label).toMatch(new RegExp(`${slug}$`))
  expect(summary.title).toContain(`Source: ${slug}`)
  expect(link).toEqual({
    url: `https://${source.host ?? 'github.com'}/${slug}`,
    label: slug
  })
}

function renderSourceRow(display: ReturnType<typeof sourceDisplay>, repos: Repo[]) {
  const setIssueSourcePreference = vi.fn()
  const model = {
    ...display,
    selectedRepos: repos,
    setIssueSourcePreference,
    taskSearchInput: '',
    appliedTaskSearch: '',
    appliedTaskQuery: parseTaskQuery(''),
    loadedGitHubAuthorLogins: [],
    primaryGithubFilterSlug: null,
    newIssueTargetRepo: null,
    githubTasksBusy: false
  } as unknown as TaskPageComposerActionsModel
  const view = render(
    <TooltipProvider>
      <TaskPageGitHubFilters model={model} />
    </TooltipProvider>
  )
  return { setIssueSourcePreference, unmount: view.unmount }
}

beforeEach(() => {
  useAppStore.setState({ ...initialStore, repos: [repo, sshTwin], workItemsCache: {} }, true)
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
  it('names and links the source the list resolved for the active kind, not the saved project', () => {
    cacheSources([[repo, 'is:open', { ...forkSources, prs: upstream }]])
    expectSourceClaim(sourceDisplay({ query: 'is:open' }), fork)
    expectSourceClaim(sourceDisplay({ query: 'is:open', kind: 'prs' }), upstream)

    // An unresolved issue source names nothing, even though the PR source resolved.
    cacheSources([[repo, 'is:open', { ...forkSources, issues: null }]])
    expectSourceClaim(sourceDisplay({ query: 'is:open' }), null)
  })

  it('keeps the same-scope source across a query change until a real invalidation', async () => {
    cacheSources([[repo, 'is:open', forkSources]])
    // Issues → PRs or a new search: the new entry is absent until its fetch lands.
    const pending = sourceDisplay({ query: 'is:pr is:open', kind: 'prs' })
    expectSourceClaim(pending, fork)
    const row = renderSourceRow(pending, [repo])
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expect(row.setIssueSourcePreference).toHaveBeenCalledWith('repo', '/repo', 'origin', 'local')
    row.unmount()
    // Notices and Retry still read only the current query's entry.
    expect(pending.perRepoSourceState[0].sources).toBeNull()
    expect(selectTaskPageUnresolvedSourceRepos([repo], pending.perRepoSourceState)).toEqual([])

    // A preference change evicts the repo's entries, so nothing stale is named afterwards.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        repos: { update: vi.fn().mockResolvedValue({ ...repo, issueSourcePreference: 'origin' }) }
      }
    })
    await useAppStore.getState().setIssueSourcePreference('repo', '/repo', 'origin', 'local')
    const evicted = sourceDisplay({ query: 'is:pr is:open', kind: 'prs' })
    expectSourceClaim(evicted, null)
    renderSourceRow(evicted, [repo]).unmount()
    expect(screen.queryByRole('group', { name: 'Issue source' })).not.toBeInTheDocument()
  })

  it('treats a present unresolved entry and a too-large query as no source', () => {
    const unresolved = { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    cacheSources([
      [repo, 'is:open', forkSources, 1],
      [repo, 'label:bug', unresolved, 2]
    ])
    expectSourceClaim(sourceDisplay({ query: 'label:bug' }), null)

    const tooLarge = 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES + 1)
    const rejected = sourceDisplay({ query: tooLarge })
    expectSourceClaim(rejected, null)
    renderSourceRow(rejected, [repo])
    expect(screen.queryByRole('group', { name: 'Issue source' })).not.toBeInTheDocument()
  })

  it('never borrows another host copy’s source and writes each row to its own host', () => {
    cacheSources([[repo, 'is:open', forkSources]])
    expectSourceClaim(sourceDisplay({ repos: [sshTwin], query: 'label:bug' }), null)

    const both = sourceDisplay({ repos: [repo, sshTwin], query: 'label:bug' })
    expect(both.githubSourceDisplayState.map((state) => state.sources?.issues ?? null)).toEqual([
      fork,
      null
    ])
    const row = renderSourceRow(both, [repo, sshTwin])
    expect(screen.getAllByRole('group', { name: 'Issue source' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expect(row.setIssueSourcePreference).toHaveBeenCalledWith('repo', '/repo', 'origin', 'local')
  })

  it('keeps Projects, GitLab, Linear and Jira summaries, and translates the source', async () => {
    cacheSources([[repo, 'is:open', { ...forkSources, issues: null }]])
    const project = sourceDisplay({ query: 'is:open', mode: 'project' })
    expect(project.taskSourceContextSummary.label).toMatch(/^GitHub · .+ · Current account$/)
    // Projects keeps its selected-repository shortcut.
    expect(project.selectedGitHubRepoExternalLink?.url).toBe(
      'https://ghe.example.com/fork-owner/project'
    )

    const gitlab = sourceDisplay({ query: 'is:open', taskSource: 'gitlab' })
    expect(gitlab.taskSourceContextSummary.label).toMatch(/^GitLab · .+ · Selected project$/)
    expect(gitlab.taskSourceContextSummary.title).not.toMatch(/Source:/)
    const linear = sourceDisplay({
      query: '',
      taskSource: 'linear',
      selectedLinearWorkspace: { id: 'ws', organizationName: 'Acme' }
    })
    expect(linear.taskSourceContextSummary.label).toMatch(/^Linear · .+ · Acme$/)
    const jira = sourceDisplay({
      query: '',
      taskSource: 'jira',
      selectedJiraSite: { id: 'site', displayName: 'Acme Jira' }
    })
    expect(jira.taskSourceContextSummary.label).toMatch(/^Jira · .+ · Acme Jira$/)

    await i18n.changeLanguage('es')
    cacheSources([[repo, 'is:open', forkSources]])
    expect(sourceDisplay({ query: 'is:open' }).taskSourceContextSummary.title).toContain(
      'Fuente: fork-owner/project'
    )
  })
})
