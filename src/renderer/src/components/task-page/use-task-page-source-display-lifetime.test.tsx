// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { taskPageGitHubResumeCache } from './github/task-page-github-resume-cache'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  Q2,
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
  it('shows the loading rows, never the empty state, from a held source click until that source answers', async () => {
    const list = vi.mocked(window.api.gh.listWorkItems).mockResolvedValue(answer(upstream))
    vi.mocked(window.api.gh.countWorkItems).mockResolvedValue(180)
    const { container } = await mountUpstream(true)
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(upstream.owner)
    const save = Promise.withResolvers<Repo>()
    vi.mocked(window.api.repos.update).mockReturnValueOnce(save.promise)
    const origin = Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    list.mockReturnValue(origin.promise)
    const expectLoading = (loading: boolean) => {
      expect(screen.queryByText('No matching GitHub work')).toBeNull()
      expect(container.querySelector('.animate-pulse') !== null).toBe(loading)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    expectLoading(true)
    await act(flush)
    expectLoading(true)
    await act(async () => {
      save.resolve({ ...repo, issueSourcePreference: 'origin' })
      await flush()
    })
    expectLoading(true)
    await act(async () => {
      origin.resolve(answer(fork))
      await flush()
    })
    expectLoading(false)
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(fork.owner)
    // An accepted empty answer is an answer: the existing empty state, never skeletons.
    list.mockResolvedValue({ items: [], sources: sources(fork) })
    await act(async () => {
      view.setAppliedTaskSearch(Q2)
      await flush()
    })
    expect(screen.getByText('No matching GitHub work')).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).toBeNull()
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
  it('rejects a held numbered page after a flip and retires mounted/resume data on origin replacement with upstream fixed', async () => {
    const list = vi.mocked(window.api.gh.listWorkItems).mockResolvedValue(answer(upstream))
    vi.mocked(window.api.gh.countWorkItems).mockResolvedValue(120)
    vi.mocked(window.api.repos.update).mockImplementation(async ({ updates }) => ({
      ...repo,
      issueSourcePreference: updates.issueSourcePreference
    }))
    await mountUpstream()
    const initialContext = view.githubResumeContextKey
    expect(taskPageGitHubResumeCache.read(initialContext, 0)?.items[0].title).toBe(upstream.owner)
    const picker = screen.getByRole('group', { name: 'Issue source' })
    const page = Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    list.mockReturnValueOnce(page.promise).mockResolvedValue(answer(fork))
    let paging!: Promise<void>
    await act(async () => {
      paging = view.handleLoadNextPage(2)
      await flush()
    })
    expect(view.paginationLoading).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
      await flush()
    })
    await act(async () => {
      page.resolve(answer(upstream))
      await paging
      await flush()
    })
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(fork.owner)
    expect(view.currentPage).toBe(0)
    expect(view.paginationLoading).toBe(false)
    expect(taskPageGitHubResumeCache.read(initialContext, 2)).toBeNull()
    const originContext = view.githubResumeContextKey
    const refreshed =
      Promise.withResolvers<Awaited<ReturnType<typeof window.api.gh.listWorkItems>>>()
    const replacement = { owner: 'new-fork', repo: 'project', host: 'ghe.example.com' }
    list
      .mockResolvedValueOnce({
        items: [item(replacement.owner)],
        sources: { ...sources(replacement), originCandidate: replacement }
      })
      .mockReturnValue(refreshed.promise)
    await act(async () => {
      await useAppStore
        .getState()
        .fetchWorkItems(repo.id, repo.path, view.githubPerRepoPageLimit, 'label:replacement', {
          force: true
        })
      await flush()
    })
    expect(screen.getByRole('group', { name: 'Issue source' })).toBe(picker)
    expect(screen.getByTestId('mounted-rows')).toBeEmptyDOMElement()
    expect(screen.getByTestId('mounted-count')).toHaveTextContent('unknown')
    expect(taskPageGitHubResumeCache.read(initialContext, 0)).toBeNull()
    expect(taskPageGitHubResumeCache.read(originContext, 0)).toBeNull()
    await act(async () => {
      refreshed.resolve({
        items: [item(replacement.owner)],
        sources: { ...sources(replacement), originCandidate: replacement }
      })
      await flush()
    })
    expect(screen.getByTestId('mounted-rows')).toHaveTextContent(replacement.owner)
  })
})
