// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import {
  Q1,
  upstream,
  fork,
  sources,
  repo,
  view,
  Harness,
  installSourceDisplayTestLifecycle
} from './use-task-page-source-display.test-fixture'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))
// The list's own states are under test; mounted-rows shows the row titles.
vi.mock('./github/Rows', () => ({ TaskPageGitHubRows: () => null }))
installSourceDisplayTestLifecycle()

describe('mounted Tasks source lifetime', () => {
  const flush = async () => {
    for (let i = 0; i < 16; i++) {
      await Promise.resolve()
    }
  }
  function item(owner: string): GitHubWorkItem {
    return {
      id: 'issue:1',
      repoId: repo.id,
      type: 'issue',
      number: 1,
      title: owner,
      state: 'open',
      url: `https://github.com/${owner}/project/issues/1`,
      labels: [],
      author: null,
      updatedAt: '2026-11-01T00:00:00Z'
    }
  }
  const answer = (owner: GitHubOwnerRepo) => ({
    items: [item(owner.owner)],
    sources: sources(owner)
  })
  // One selected repo on Upstream, its first list answered and the resume step done.
  async function mountUpstream(list = false, repos = [repo]) {
    useAppStore.setState({
      repos,
      settings: createGlobalSettingsFixture({ defaultRepoSelection: [repo.id] }),
      taskPageData: { taskSource: 'github' }
    })
    let mounted!: ReturnType<typeof render>
    await act(async () => {
      mounted = render(<Harness runRequests list={list} />)
    })
    await act(async () => {
      view.setTaskResumeApplied(true)
      await flush()
    })
    return mounted
  }
  it('keeps the mounted picker across a held save/list and ends an inverted A→B→A with its own rows and count', async () => {
    const list = vi.mocked(window.api.gh.listWorkItems).mockResolvedValue(answer(upstream))
    const count = vi.mocked(window.api.gh.countWorkItems).mockResolvedValue(180)
    await mountUpstream()
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(upstream.owner)
    const knownA = screen.getByTestId('mounted-count').textContent
    expect(knownA).not.toBe('unknown')
    const picker = screen.getByRole('group', { name: 'Issue source' })
    const save = Promise.withResolvers<Repo>()
    vi.mocked(window.api.repos.update).mockReturnValueOnce(save.promise)
    const b = Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    list.mockReturnValue(b.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
      await flush()
    })
    expect(screen.getByRole('group', { name: 'Issue source' })).toBe(picker)
    expect(screen.getByRole('button', { name: 'Origin' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mounted-rows')).toBeEmptyDOMElement()
    expect(screen.getByTestId('mounted-count')).toHaveTextContent('unknown')
    await act(async () => {
      save.resolve({ ...repo, issueSourcePreference: 'origin' })
      await flush()
    })
    const a = Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    const nextCount = Promise.withResolvers<number>()
    list.mockReturnValue(a.promise)
    count.mockReturnValue(nextCount.promise)
    vi.mocked(window.api.repos.update).mockImplementation(async ({ updates }) => ({
      ...repo,
      issueSourcePreference: updates.issueSourcePreference
    }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upstream' }))
      await flush()
    })
    expect(screen.getByRole('group', { name: 'Issue source' })).toBe(picker)
    expect(screen.getByTestId('mounted-count')).toHaveTextContent(knownA!)
    await act(async () => {
      a.resolve(answer(upstream))
      nextCount.resolve(72)
      await flush()
    })
    const currentCount = screen.getByTestId('mounted-count').textContent
    await act(async () => {
      b.resolve(answer(fork))
      await flush()
    })
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(upstream.owner)
    expect(screen.getByTestId('mounted-count')).toHaveTextContent(currentCount!)
    expect(view.tasksLoading).toBe(false)
    expect(view.tasksRefreshing).toBe(false)
    // A selected source's known total remains visible while its next answer is held.
    const refresh = Promise.withResolvers<number>()
    count.mockReturnValue(refresh.promise)
    await act(async () => {
      view.setTaskRefreshNonce((n) => n + 1)
      await flush()
    })
    expect(screen.getByTestId('mounted-count')).toHaveTextContent(currentCount!)
    await act(async () => {
      refresh.resolve(108)
      await flush()
    })
    expect(screen.getByTestId('mounted-count').textContent).not.toBe(currentCount)
  })
  it('ends loading at once when a held save loses its last selected owner, and Refresh keeps it ended', async () => {
    const list = vi.mocked(window.api.gh.listWorkItems).mockResolvedValue(answer(upstream))
    // A folder project keeps Tasks open after the only GitHub-eligible repo is removed.
    const folder: Repo = {
      ...repo,
      id: 'folder',
      path: '/folder',
      kind: 'folder',
      upstream: undefined
    }
    const { container } = await mountUpstream(true, [repo, folder])
    const save = Promise.withResolvers<Repo>()
    vi.mocked(window.api.repos.update).mockReturnValueOnce(save.promise)
    const origin = Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    list.mockReturnValue(origin.promise)
    const skeletons = () => container.querySelector('.animate-pulse') !== null
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
      await flush()
    })
    expect(skeletons()).toBe(true)
    expect(screen.queryByText('No matching GitHub work')).toBeNull()
    const ended = () => {
      expect(view.selectedRepos).toEqual([])
      expect(useAppStore.getState().githubSourceCollections.saving(repo)).toBe(false)
      expect(skeletons()).toBe(false)
      expect(screen.getByTestId('mounted-pending')).toHaveTextContent('false')
      expect(screen.getByTestId('mounted-rows')).toBeEmptyDOMElement()
    }
    await act(async () => {
      useAppStore.setState({ repos: [folder] })
      await flush()
    })
    ended()
    await act(async () => {
      save.resolve({ ...repo, issueSourcePreference: 'origin' })
      origin.resolve(answer(fork))
      await flush()
    })
    await act(async () => {
      view.setTaskRefreshNonce((n) => n + 1)
      await flush()
    })
    ended()
  })

  it.each(['upstream', 'origin'] as const)(
    "settles repeated legacy-host deliveries with explicit source preferences and shows each kind's reported source and count",
    async (preference) => {
      clearRuntimeCompatibilityCacheForTests()
      // A paired host up to v1.4.60: issues follow the saved preference, PRs resolve origin, no originCandidate.
      const legacy = {
        issues: preference === 'upstream' ? upstream : fork,
        prs: fork,
        upstreamCandidate: upstream
      }
      const QP = 'is:pr is:open'
      const totals: Record<string, number> = { [Q1]: 120, [QP]: 300 }
      const held: { method: string; query: string; resolve: (response: unknown) => void }[] = []
      const call = vi.fn(({ method, params }: { method: string; params?: { query?: string } }) => {
        if (method === 'status.get') {
          return Promise.resolve(createCompatibleRuntimeStatusResponse())
        }
        const { promise, resolve } = Promise.withResolvers<unknown>()
        // Row decorations such as PR checks are outside the list/count cycle under test.
        if (method === 'github.listWorkItems' || method === 'github.countWorkItems') {
          held.push({ method, query: params?.query ?? '', resolve })
        }
        return promise
      })
      Object.assign(window.api, { runtimeEnvironments: { call } })
      const recovery = vi.fn(async () => {})
      const hosted: Repo = {
        ...repo,
        path: '/server/project',
        executionHostId: 'runtime:env-1',
        issueSourcePreference: preference
      }
      useAppStore.setState({
        repos: [hosted],
        settings: createGlobalSettingsFixture({ defaultRepoSelection: [hosted.id] }),
        taskPageData: { taskSource: 'github' },
        fetchReposForAllHosts: recovery
      })
      const { container } = render(<Harness runRequests list />)
      await act(async () => {
        view.setAppliedTaskSearch(Q1)
        view.setTaskResumeApplied(true)
        await flush()
      })
      const collections = useAppStore.getState().githubSourceCollections
      const lifetime = () => [
        collections.context(hosted),
        useAppStore.getState().workItemsInvalidationNonce
      ]
      const before = lifetime()
      // Answers exactly the one list and count this action owes; an unsolicited next request stays held and fails.
      const deliver = async (query: string) => {
        expect(held.map((entry) => entry.method).sort()).toEqual([
          'github.countWorkItems',
          'github.listWorkItems'
        ])
        expect(held.every((entry) => entry.query === query)).toBe(true)
        const kind = query === QP ? 'pr' : 'issue'
        const source = kind === 'pr' ? legacy.prs : legacy.issues
        for (const entry of held.splice(0)) {
          const result =
            entry.method === 'github.countWorkItems'
              ? totals[query]
              : {
                  items: [{ ...item(`${source.owner} ${kind}`), id: `${kind}:1`, type: kind }],
                  sources: legacy
                }
          entry.resolve({
            id: entry.method,
            ok: true,
            result,
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        await act(flush)
        await act(flush)
        expect(held).toEqual([])
        expect(recovery).not.toHaveBeenCalled()
        expect(lifetime()).toEqual(before)
        const slug = `${source.owner}/${source.repo}`
        expect(screen.getByTestId('mounted-rows')).toHaveTextContent(`${source.owner} ${kind}`)
        expect(screen.getByTestId('mounted-count')).toHaveTextContent(
          String(Math.ceil(totals[query] / view.githubPerRepoPageLimit))
        )
        expect(container.querySelector('.animate-pulse')).toBeNull()
        expect(screen.getByTestId('mounted-pending')).toHaveTextContent('false')
        expect(view.tasksLoading || view.tasksRefreshing || view.tasksFiltering).toBe(false)
        expect(view.taskSourceContextSummary.title).toContain(`Source: ${slug}`)
        expect(view.selectedGitHubRepoExternalLink?.label).toBe(slug)
        expect(screen.queryByRole('group', { name: 'Issue source' })).toBeNull()
      }
      await deliver(Q1)
      await act(async () => {
        view.setAppliedTaskSearch(QP)
        await flush()
      })
      // The issue total never stands in for the PR query's.
      expect(screen.getByTestId('mounted-count')).toHaveTextContent('unknown')
      await deliver(QP)
      // Two explicit Refreshes with identical answers: one list/count cycle each, then quiet.
      for (let press = 0; press < 2; press++) {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh GitHub work' }))
          await flush()
        })
        await deliver(QP)
      }
    }
  )
})
