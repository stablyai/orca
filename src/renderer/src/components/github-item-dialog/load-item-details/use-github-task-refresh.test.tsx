// @vitest-environment happy-dom
import { parseTaskQuery } from '../../../../../shared/task-query'
import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '@/store/slices/github-slice-test-harness'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../shared/repo-types'
import type {
  GitHubWorkItemDetails,
  GitHubWorkItem
} from '../../../../../shared/github/work-item-types'
import { buildTaskSourceContextFromRepo } from '../../../../../shared/task-source-context'
import { useGitHubTaskRefresh } from './use-github-task-refresh'
import { workItemDetailsCache } from './work-item-details-cache'
import { useGitHubTaskItems } from '@/hooks/useGitHubTaskItems'

const mocks = vi.hoisted(() => ({
  store: null as ReturnType<typeof createTestStore> | null,
  details: vi.fn(),
  item: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: AppState) => unknown) => useStore(mocks.store!, selector),
    {
      getState: () => mocks.store!.getState(),
      subscribe: (listener: (s: AppState) => void) => mocks.store!.subscribe(listener)
    }
  )
}))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemDetailsForSource: mocks.details,
  lookupGitHubWorkItemByOwnerRepoForSource: mocks.item
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1
}
const row: GitHubWorkItem = {
  id: 'issue:42',
  repoId: 'repo',
  type: 'issue',
  number: 42,
  title: 'Visible',
  state: 'open',
  labels: [],
  assignees: [],
  url: 'https://github.com/acme/widgets/issues/42',
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
}
const source = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
const details: GitHubWorkItemDetails = { item: row, body: 'Body stays visible', comments: [] }
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
let root: Root, node: HTMLDivElement
const query = parseTaskQuery('is:open assignee:alice')
let mutationModel: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
let model: ReturnType<typeof useGitHubTaskRefresh>
function Harness() {
  mutationModel = useTaskPageGitHubWorkItemMutation({
    queryKey: 'record-test',
    query,
    viewerLogin: 'alice',
    patchWorkItem: mocks.store!.getState().patchWorkItem
  })
  model = useGitHubTaskRefresh({
    workItem: row,
    repoPath: repo.path,
    effectiveRepoId: repo.id,
    sourceContext: source,
    issueRepository: { owner: 'acme', repo: 'widgets' }
  })
  const rows = useMemo(
    () =>
      mocks
        .store!.getState()
        .githubTaskCache.acceptSearch(
          [row],
          mocks.store!.getState().githubTaskCache.capture(repo, source)
        ),
    []
  )
  const projected = useGitHubTaskItems(rows)
  return (
    <output>
      {projected[0]?.title}|{model.refreshing ? 'loading' : 'idle'}
    </output>
  )
}
async function render() {
  await act(async () => {
    root.render(<Harness />)
  })
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Refresh task with real shared record and mounted copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    workItemDetailsCache.clear()
    Object.assign(mockApi.gh, { workItemByOwnerRepo: vi.fn() })
    mocks.store = createTestStore()
    mocks.store.setState({ repos: [repo], recordFeatureInteraction: vi.fn() })
    mocks.details.mockReset()
    mocks.item.mockReset()
    mocks.item.mockResolvedValue(row)
    node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    node.remove()
  })

  it('retains visible data while loading, publishes all metadata and keeps data on retryable failure', async () => {
    await render()
    const response = deferred<GitHubWorkItemDetails>()
    mocks.details.mockReturnValueOnce(response.promise)
    let refresh!: Promise<void>
    await act(async () => {
      refresh = model.refreshTask()
      await Promise.resolve()
    })
    expect(node.textContent).toContain('Visible|loading')
    await act(async () => {
      response.resolve({ ...details, item: { ...row, title: 'Fresh', labels: ['new'] } })
      await refresh
    })
    expect(node.textContent).toContain('Fresh|idle')
    mocks.details.mockRejectedValueOnce(new Error('raw provider detail'))
    await act(async () => {
      await model.refreshTask()
    })
    expect(node.textContent).toBe('Fresh|idle')
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      'Unable to refresh this task. Try again.'
    )
    mocks.details.mockResolvedValueOnce({ ...details, item: { ...row, title: 'Recovered' } })
    await act(async () => {
      await model.refreshTask()
    })
    expect(node.textContent).toBe('Recovered|idle')
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('waits for a pending write, cancels a read crossed by an edit and reloads after settlement', async () => {
    await render()
    const first = deferred<GitHubWorkItemDetails>()
    mocks.details
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...details, item: { ...row, title: 'After edit' } })
    let refresh!: Promise<void>
    await act(async () => {
      refresh = model.refreshTask()
      await Promise.resolve()
    })
    const cache = mocks.store!.getState().githubTaskCache
    let settle!: (success: boolean) => GitHubWorkItem | null
    await act(async () => {
      settle = cache.operation(row, cache.capture(repo, source)!, (base) => ({
        ...base,
        labels: ['edited']
      }))
      await Promise.resolve()
    })
    first.resolve({ ...details, item: { ...row, title: 'Pre-edit' } })
    await flush()
    expect(node.textContent).not.toContain('Pre-edit')
    await act(async () => {
      settle(true)
      await refresh
    })
    expect(mocks.details).toHaveBeenCalledTimes(2)
    expect(node.textContent).toBe('After edit|idle')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('discards old-account deferred mounted copies on A to B to A', async () => {
    await render()
    const response = deferred<GitHubWorkItemDetails>()
    mocks.details.mockReturnValueOnce(response.promise)
    let refresh!: Promise<void>
    await act(async () => {
      refresh = model.refreshTask()
      await Promise.resolve()
    })
    await act(async () => {
      mocks.store!.setState({
        repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }]
      })
      mocks.store!.setState({ repos: [repo] })
    })
    await act(async () => {
      response.resolve({ ...details, item: { ...row, title: 'Old binding' } })
      await refresh
    })
    expect(node.textContent).not.toContain('Old binding')
    // Rows are never hidden for a binding change; only the old record is dropped.
    expect(node.textContent).toBe('Visible|idle')
  })
  it('confirms a Tasks-row remove against the accepted base and lets external state replace it', async () => {
    const cache = mocks.store!.getState().githubTaskCache,
      binding = cache.capture(repo, source)!
    const alice = { login: 'alice', name: null, avatarUrl: '' }
    await cache.readCanonical(row, binding, async () => ({ ...row, assignees: [alice] }))
    mocks.item.mockResolvedValue({ ...row, assignees: [alice] })
    await render()
    const pending = deferred<void>()
    const canonical = deferred<GitHubWorkItem>()
    mocks.item.mockReturnValue(canonical.promise)
    let result!: Promise<'confirmed' | 'rolled_back' | 'stale'>
    await act(async () => {
      result = mutationModel.run({
        item: cache.projectItem(row),
        intent: { type: 'toggleAssignee', user: alice },
        sourceContext: source,
        mutate: () => pending.promise,
        errorToast: 'Unable to update'
      })
      await Promise.resolve()
    })
    expect(cache.projectItem(row).assignees).toEqual([])
    await act(async () => {
      pending.resolve()
      expect(await result).toBe('confirmed')
    })
    expect(cache.projectItem(row).assignees).toEqual([])
    await act(async () => {
      canonical.resolve({ ...row, assignees: [alice], updatedAt: '2026-10-31T12:00:03Z' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(cache.projectItem(row).assignees).toEqual([alice])
  })

  it('rolls a failed Tasks-row assign back through the record without a canonical read', async () => {
    const cache = mocks.store!.getState().githubTaskCache
    await render()
    const alice = { login: 'alice', name: null, avatarUrl: '' }
    const failure = deferred<{ ok: false; error: string }>()
    let result!: Promise<'confirmed' | 'rolled_back' | 'stale'>
    await act(async () => {
      result = mutationModel.run({
        item: row,
        intent: { type: 'toggleAssignee', user: alice },
        sourceContext: source,
        mutate: () => failure.promise,
        errorToast: 'Unable to update'
      })
      await Promise.resolve()
    })
    expect(cache.projectItem(row).assignees).toEqual([alice])
    await act(async () => {
      failure.resolve({ ok: false, error: 'denied' })
      expect(await result).toBe('rolled_back')
    })
    expect(cache.projectItem(row).assignees).toEqual([])
    expect(mocks.item).not.toHaveBeenCalled()
  })

  it('waits when Refresh begins during a pending edit without disabling the edit', async () => {
    await render()
    const cache = mocks.store!.getState().githubTaskCache
    const settle = cache.operation(row, cache.capture(repo, source)!, (base) => ({
      ...base,
      labels: ['pending']
    }))
    mocks.details.mockResolvedValueOnce({ ...details, item: { ...row, title: 'After pending' } })
    let refresh!: Promise<void>
    await act(async () => {
      refresh = model.refreshTask()
      await Promise.resolve()
    })
    expect(mocks.details).not.toHaveBeenCalled()
    expect(node.textContent).toContain('Visible|loading')
    await act(async () => {
      settle(true)
      await refresh
    })
    expect(node.textContent).toBe('After pending|idle')
  })
})
