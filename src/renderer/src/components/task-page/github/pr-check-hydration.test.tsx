import { Suspense, startTransition, useState } from 'react'
// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { TaskPageJiraCreationMetadataModel } from '../jira/use-task-page-jira-creation-metadata'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as capability } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
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
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
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

it.each([true, false])(
  'only a committed query replacement retires a pending read (suspend=%s)',
  async (suspend) => {
    const row = item(42)
    let current = row
    const patch = vi.fn((_key, values, accepts: (item: GitHubWorkItem) => boolean) => {
      if (accepts(current)) {
        current = { ...current, ...values }
      }
    })
    const original = Promise.withResolvers<GitHubWorkItem>()
    const replacement = Promise.withResolvers<GitHubWorkItem>()
    const blocked = Promise.withResolvers<void>()
    const summary = {
      state: 'failure' as const,
      total: 1,
      passed: 0,
      failed: 1,
      cancelled: 0,
      pending: 0,
      neutral: 0
    }
    lookup.mockReturnValueOnce(original.promise).mockReturnValueOnce(replacement.promise)
    const first = model([row], patch)
    const second = { ...first, appliedTaskSearch: 'replacement' }
    let navigate!: (next: boolean) => void
    function Consumer({ next }: { next: boolean }) {
      useTaskPageGitHubListProjection(next ? second : first)
      if (next && suspend) {
        throw blocked.promise
      }
      return <span>{next ? 'Replacement query' : 'Original query'}</span>
    }
    function Harness() {
      const [next, setNext] = useState(false)
      navigate = setNext
      return (
        <Suspense fallback={<span>Waiting</span>}>
          <Consumer next={next} />
        </Suspense>
      )
    }
    const view = render(<Harness />)
    await act(async () => {
      startTransition(() => navigate(true))
    })
    expect(screen.getByText(suspend ? 'Original query' : 'Replacement query')).toBeTruthy()
    await act(async () => {
      original.resolve({ ...row, checksSummary: summary })
      await original.promise
    })
    expect(current.checksSummary).toEqual(suspend ? summary : undefined)
    view.unmount()
    await act(async () => {
      replacement.resolve({ ...row, checksSummary: summary })
      blocked.resolve()
      await replacement.promise
    })
  }
)
