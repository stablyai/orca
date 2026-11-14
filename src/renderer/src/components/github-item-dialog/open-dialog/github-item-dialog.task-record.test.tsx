// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '@/store/github/github-slice-test-harness'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'

import { buildTaskSourceContextFromRepo } from '../../../../../shared/work-items/task-source-context'

import { workItemDetailsCache } from '../load-item-details/work-item-details-cache'
import GitHubItemDialog from './github-item-dialog'

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: ReturnType<typeof createTestStore> | null
    details: Mock
    item: Mock
    update: Mock
    onUse: Mock
  } = { store: null, details: vi.fn(), item: vi.fn(), update: vi.fn(), onUse: vi.fn() }
  return hoisted
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: AppState) => unknown) => useStore(mocks.store!, selector),
    {
      getState: () => mocks.store!.getState(),
      subscribe: (listener: (s: AppState) => void) => mocks.store!.subscribe(listener)
    }
  )
}))
vi.mock('@/store/slices/worktrees/listing/use-worktree-catalog', () => ({
  useAllWorktrees: () => []
}))
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemDetailsForSource: mocks.details,
  lookupGitHubWorkItemByOwnerRepoForSource: mocks.item
}))
vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runIssueUpdate: mocks.update
}))
vi.mock('@/hooks/useIssueMetadata', async () => ({
  useImmediateMutation: (await import('@/hooks/useImmediateMutation')).useImmediateMutation,
  useRepoLabels: () => ({ data: [] }),
  useRepoAssignees: () => ({ data: [] })
}))
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoLabelsBySlug: () => ({ data: [] }),
  useRepoAssigneesBySlug: () => ({ data: [] })
}))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<object>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./github-item-dialog-issue-header', () => ({
  GitHubItemDialogIssueHeader: (props: {
    workItem: GitHubWorkItem
    handleOpenOrUseIssueWorkspace: (item: GitHubWorkItem) => void
    refreshTask?: () => Promise<void>
    refreshing: boolean
  }) => (
    <>
      <button onClick={() => props.handleOpenOrUseIssueWorkspace(props.workItem)}>Start</button>
      <button onClick={() => void props.refreshTask?.()}>Refresh</button>
      <output data-field="refreshing">{String(props.refreshing)}</output>
    </>
  )
}))
vi.mock('./github-item-dialog-pr-header', () => ({ GitHubItemDialogPRHeader: () => null }))
vi.mock('./github-item-dialog-pr-tabs', () => ({ GitHubItemDialogPRTabs: () => null }))
vi.mock('../discuss-item/conversation-tab', () => ({
  ConversationTab: (props: { body: string }) => <output data-field="body">{props.body}</output>
}))
vi.mock('../edit-item-fields/gh-edit-section-top-columns', () => ({
  GHEditSectionTopColumns: (props: {
    localAssignees: string[]
    localLabels: string[]
    onAssigneeToggle: (login: string) => void
    onLabelToggle: (label: string) => void
    onStateChange: (state: 'open' | 'closed') => void
  }) => (
    <>
      <output data-field="dialog">{props.localAssignees.join(',')}</output>
      <output data-field="labels">{props.localLabels.join(',')}</output>
      <button onClick={() => props.onAssigneeToggle('alice')}>Assign me</button>
      <button onClick={() => props.onLabelToggle('bug')}>Label bug</button>
      <button onClick={() => props.onStateChange('closed')}>Close</button>
    </>
  )
}))

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1
}
const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: null,
  originCandidate: null,
  upstreamCandidate: null
}
const row: GitHubWorkItem = {
  id: 'issue:42',
  repoId: 'repo',
  type: 'issue',
  number: 42,
  title: 'Assign then start',
  state: 'open',
  labels: [],
  assignees: [],
  url: 'https://github.com/acme/widgets/issues/42',
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
}
const alice = { login: 'alice', name: null, avatarUrl: 'alice.png' }
const source = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
let root: Root, node: HTMLDivElement

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })
  return { promise, resolve, reject }
}

/** F1 input: a board fetched after the Tasks row, so its title, state and members are fresher. */

async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick++) {
      await Promise.resolve()
    }
  })
}
function renderDialog() {
  return act(async () => {
    root.render(
      <GitHubItemDialog
        workItem={row}
        repoPath={repo.path}
        repoId={repo.id}
        sourceContext={source}
        onUse={mocks.onUse}
        onClose={() => {}}
      />
    )
  })
}

const text = (field: string) => node.querySelector(`[data-field="${field}"]`)?.textContent
async function click(label: string) {
  const button = [...node.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
}

describe('issue dialog edits reach the Tasks row through the shared record', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // One-shot responses a case queued but never consumed must not leak into the next case.
    for (const mock of [mocks.details, mocks.item, mocks.update]) {
      mock.mockReset()
    }
    resetRemoteRuntimeMocks()
    workItemDetailsCache.clear()
    mocks.store = createTestStore()
    mocks.store.setState({
      repos: [repo],
      recordFeatureInteraction: vi.fn(),
      allWorktrees: () => []
    })
    mocks.details.mockResolvedValue({ item: row, body: 'Body', comments: [], assignees: [] })
    mocks.item.mockResolvedValue({ ...row, assignees: [alice], updatedAt: '2026-10-31T12:00:03Z' })
    mocks.update.mockResolvedValue({ ok: true })
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [row], sources })
    node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    node.remove()
  })

  it('keeps an in-flight label chip when the state changes meanwhile', async () => {
    const label = deferred<{ ok: boolean }>()
    mocks.update.mockReturnValueOnce(label.promise)
    await renderDialog()
    await settle()
    await click('Label bug')
    expect(text('labels')).toBe('bug')
    await click('Close')
    await settle()
    expect(text('labels')).toBe('bug')
    await act(async () => label.resolve({ ok: false }))
    await settle()
    expect(text('labels')).toBe('')
  })
})
