import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { useAppStore } from '@/store'
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskPageJiraCreationMetadataModel } from '../jira/use-task-page-jira-creation-metadata'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useTaskPageGitHubListProjection } from './use-task-page-github-list-projection'

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({ runtimeStatusByEnvironmentId: new Map() })) }
})
vi.mock('@/hooks/useGitHubTaskItems', () => ({
  useGitHubTaskItems: (items: GitHubWorkItem[]) => items
}))
vi.mock('./use-task-page-github-list-pending', () => ({
  useTaskPageGitHubListPending: () => false
}))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: lookup
}))
const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 1,
  kind: 'git' as const
}
const prRepo = { owner: 'acme', repo: 'widgets', host: 'github.com' }
function item(number: number): GitHubWorkItem {
  return {
    id: `pr-${number}`,
    repoId: repo.id,
    number,
    type: 'pr',
    title: 'PR',
    state: 'open',
    url: `https://github.com/acme/widgets/pull/${number}`,
    labels: [],
    author: null,
    updatedAt: '2026-11-04',
    headSha: 'head',
    prRepo
  }
}
function model(items: GitHubWorkItem[], patch = vi.fn()) {
  const input = {
    repos: [repo],
    selectedRepos: [repo],
    fetchPRChecks: vi.fn().mockResolvedValue([]),
    taskSource: 'github',
    githubMode: 'items',
    tasksFiltering: false,
    githubPageSize: 100,
    pages: [items],
    currentPage: 0,
    countedTotalPages: 1,
    provenPageLimit: 1,
    patchTaskPageWorkItemRows: patch,
    perRepoSourceState: [],
    activeGithubTaskKind: 'prs',
    githubWorkItemMutation: { softHiddenItemKeys: new Set() },
    selectedReposKey: 'repo',
    taskRefreshNonce: 0,
    workItemsInvalidationNonce: 0,
    appliedTaskSearch: '',
    paginationGenerationRef: { current: 1 }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies all fields the projection hook reads.
  return input as unknown as TaskPageJiraCreationMetadataModel
}
beforeEach(() => {
  lookup.mockReset()
  setLocalRuntimeCapabilitiesForTests([capability])
})
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

it.each([100, 1000])(
  'bounds automatic exact hydration at N=%i and coalesces demand while failures terminate',
  async (n) => {
    const items = Array.from({ length: n }, (_, i) => item(i + 1))
    const input = model(items)
    lookup.mockResolvedValue(null)
    const view = renderHook(() => useTaskPageGitHubListProjection(input))
    await act(async () => {})
    expect(lookup).toHaveBeenCalledTimes(20)
    act(() => {
      view.result.current.ensurePRChecksLoaded(items[20])
      view.result.current.ensurePRChecksLoaded(items[20])
    })
    await act(async () => {})
    expect(lookup).toHaveBeenCalledTimes(21)
    view.rerender()
    await act(async () => {})
    expect(lookup).toHaveBeenCalledTimes(21)
    expect(input.fetchPRChecks).not.toHaveBeenCalled()
  }
)

it('publishes exact-owner counts, rejects a newer owner replacement, and retires source changes', async () => {
  const row = item(42)
  let current = row
  const patch = vi.fn((_key, values, accepts: (item: GitHubWorkItem) => boolean) => {
    if (accepts(current)) {
      current = { ...current, ...values }
    }
  })
  const input = model([row], patch)
  const read = Promise.withResolvers<GitHubWorkItem>()
  lookup.mockReturnValue(read.promise)
  const view = renderHook(() => useTaskPageGitHubListProjection(input))
  const summary = {
    state: 'failure' as const,
    total: 101,
    passed: 100,
    failed: 1,
    cancelled: 0,
    pending: 0,
    neutral: 0
  }
  await act(async () => {
    read.resolve({ ...row, checksSummary: summary })
    await read.promise
  })
  expect(current.checksSummary).toEqual(summary)
  // A late hydration read cannot replace a newer full observation on the same head.
  input.taskRefreshNonce++
  input.paginationGenerationRef.current++
  const second = Promise.withResolvers<GitHubWorkItem>()
  lookup.mockReturnValue(second.promise)
  view.rerender()
  current = { ...row, checksSummary: { ...summary, failed: 2, total: 102 } }
  await act(async () => {
    second.resolve({ ...row, checksSummary: summary })
    await second.promise
  })
  expect(current.checksSummary?.failed).toBe(2)
  const third = Promise.withResolvers<GitHubWorkItem>()
  lookup.mockReturnValue(third.promise)
  input.taskRefreshNonce++
  view.rerender()
  view.unmount()
  const previousCalls = patch.mock.calls.length
  await act(async () => {
    third.resolve({ ...row, checksSummary: summary })
    await third.promise
  })
  expect(patch.mock.calls.length).toBe(previousCalls)
})

it('does not rerender or rearm failed demand on unrelated host writes or capacity pressure; explicit refresh retries', async () => {
  const input = model(Array.from({ length: 200 }, (_, i) => item(i + 1)))
  lookup.mockResolvedValue(null)
  let renders = 0
  const view = renderHook(() => {
    renders++
    return useTaskPageGitHubListProjection(input)
  })
  await act(async () => {})
  act(() => {
    for (const row of input.pages[0] ?? []) {
      view.result.current.ensurePRChecksLoaded(row)
    }
  })
  await act(async () => {})
  const calls = lookup.mock.calls.length
  const before = renders
  act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
  await act(async () => {})
  expect(renders).toBe(before)
  view.rerender()
  await act(async () => {})
  expect(lookup).toHaveBeenCalledTimes(calls)
  input.taskRefreshNonce++
  view.rerender()
  await act(async () => {})
  expect(lookup).toHaveBeenCalledTimes(calls + 20)
})

it('ignores an unselected remote source change and hydrates again when the selected source changes', async () => {
  const selectedRepo = { ...repo, executionHostId: 'runtime:host-a' as const }
  const unselectedRepo = { ...repo, id: 'repo-b', executionHostId: 'runtime:host-b' as const }
  const setStatus = (host: string, runtimeId: string) => {
    const response = createCompatibleRuntimeStatusResponse(runtimeId)
    if (!response.ok) {
      throw new Error('Expected a runtime status')
    }
    const statuses = new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
    statuses.set(host, { status: { ...response.result, capabilities: [capability] }, checkedAt: 1 })
    useAppStore.setState({ runtimeStatusByEnvironmentId: statuses })
  }
  setStatus('host-a', 'a1')
  setStatus('host-b', 'b1')
  const input = model([item(42)])
  input.repos = [selectedRepo, unselectedRepo]
  input.selectedRepos = [selectedRepo]
  lookup.mockResolvedValue(null)
  let renders = 0
  renderHook(() => {
    renders++
    return useTaskPageGitHubListProjection(input)
  })
  await act(async () => {})
  expect(lookup).toHaveBeenCalledTimes(1)
  const before = renders
  act(() => setStatus('host-b', 'b2'))
  await act(async () => {})
  expect(renders).toBe(before)
  expect(lookup).toHaveBeenCalledTimes(1)
  act(() => setStatus('host-a', 'a2'))
  await act(async () => {})
  expect(renders).toBeGreaterThan(before)
  expect(lookup).toHaveBeenCalledTimes(2)
})
