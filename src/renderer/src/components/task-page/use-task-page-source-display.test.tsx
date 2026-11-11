// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import type { WorkItemsCacheSources } from '@/store/github/cache/cache-model'

import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { getTaskPageRepoSourceContext } from '../../lib/work-items/task-repo-source-context'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import {
  Q1,
  Q2,
  upstream,
  fork,
  sources,
  repo,
  sshTwin,
  listAnswers,
  setIssueSourcePreference,
  view,
  Harness,
  installSourceDisplayTestLifecycle
} from './use-task-page-source-display.test-fixture'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))

installSourceDisplayTestLifecycle()

function mount(
  repos: Repo[],
  query = Q1,
  projectGroupingMode: 'repository' | 'host' = 'repository'
) {
  useAppStore.setState({
    repos,
    settings: createGlobalSettingsFixture({
      projectGroupingMode,
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
function expectSurfaces(
  source: (GitHubOwnerRepo & { host?: string }) | null,
  knownCandidates = false
) {
  const { taskSourceContextSummary: summary, selectedGitHubRepoExternalLink: link } = view
  if (!source) {
    expect(summary.label).toMatch(/Selected project$/)
    expect(summary.title).not.toMatch(/Source:/)
    expect(link).toBeNull()
    expect(sourceRowCount()).toBe(knownCandidates ? 1 : 0)
    return
  }
  const slug = `${source.owner}/${source.repo}`
  expect(summary.label).toMatch(new RegExp(`${slug}$`))
  expect(summary.title).toContain(`Source: ${slug}`)
  expect(link).toEqual({ url: `https://${source.host ?? 'github.com'}/${slug}`, label: slug })
  expect(sourceRowCount()).toBe(1)
}

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
    // A changed served mapping retires old claims across queries; raw choices stay mounted.
    await fetchList(repo, 'is:issue is:closed', sources(fork))
    expectSurfaces(null, true)

    await fetchList(repo, Q2, sources(fork))
    expectSurfaces(fork)
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expect(setIssueSourcePreference).toHaveBeenCalledWith('repo', '/repo', 'origin', 'local')

    // An owned preference change detaches rows while known choices stay mounted.
    applyQuery('is:issue is:closed sort:updated')
    expectSurfaces(fork)
    await act(() =>
      useAppStore.getState().setIssueSourcePreference('repo', '/repo', 'upstream', 'local')
    )
    expectSurfaces(null, true)
    await fetchList(repo, 'is:issue is:closed sort:updated', sources(upstream))
    expectSurfaces(upstream)
  })

  it('keeps each host copy and selected row on its own history', async () => {
    mount([repo, sshTwin], Q1, 'host')
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
    act(() => view.setRepoSelection(new Set([getRepoHostIdentity(sshTwin)])))
    expect(view.selectedRepos).toEqual([sshTwin])
    act(() => view.setRepoSelection(new Set(['repo'])))
    expect(view.githubSourceDisplayState.map((state) => state.sources?.issues ?? null)).toEqual([
      null,
      null
    ])
    expect(sourceRowCount()).toBe(1)
  })
})
