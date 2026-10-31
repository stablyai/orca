// @vitest-environment happy-dom
import { act } from 'react'
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
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { buildTaskSourceContextFromRepo } from '../../../../../shared/task-source-context'
import { useGitHubTaskItems } from '@/hooks/useGitHubTaskItems'
import { workItemDetailsCache } from '../load-item-details/work-item-details-cache'
import GitHubItemDialog from './github-item-dialog'

const mocks = vi.hoisted(() => ({
  store: null as ReturnType<typeof createTestStore> | null,
  details: vi.fn(),
  item: vi.fn(),
  update: vi.fn(),
  onUse: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: AppState) => unknown) => useStore(mocks.store!, selector),
    {
      getState: () => mocks.store!.getState(),
      subscribe: (listener: (s: AppState) => void) => mocks.store!.subscribe(listener)
    }
  )
}))
vi.mock('@/store/selectors', () => ({ useAllWorktrees: () => [] }))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
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
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./github-item-dialog-issue-header', () => ({
  GitHubItemDialogIssueHeader: (props: {
    workItem: GitHubWorkItem
    handleOpenOrUseIssueWorkspace: (item: GitHubWorkItem) => void
  }) => <button onClick={() => props.handleOpenOrUseIssueWorkspace(props.workItem)}>Start</button>
}))
vi.mock('./github-item-dialog-pr-header', () => ({ GitHubItemDialogPRHeader: () => null }))
vi.mock('./github-item-dialog-pr-tabs', () => ({ GitHubItemDialogPRTabs: () => null }))
vi.mock('../discuss-item/conversation-tab', () => ({ ConversationTab: () => null }))
vi.mock('../edit-item-fields/gh-edit-section-top-columns', () => ({
  GHEditSectionTopColumns: (props: {
    localAssignees: string[]
    onAssigneeToggle: (login: string) => void
  }) => (
    <>
      <output data-field="dialog">{props.localAssignees.join(',')}</output>
      <button onClick={() => props.onAssigneeToggle('alice')}>Assign me</button>
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

function TasksRow({ rows }: { rows: GitHubWorkItem[] }) {
  const [projected] = useGitHubTaskItems(rows)
  return <output data-field="tasks">{projected.assignees?.map((u) => u.login).join(',')}</output>
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
    resetRemoteRuntimeMocks()
    workItemDetailsCache.clear()
    mocks.store = createTestStore()
    mocks.store.setState({
      repos: [repo],
      recordFeatureInteraction: vi.fn(),
      allWorktrees: () => []
    } as Partial<AppState>)
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

  it('assigns in the dialog, keeps it through a stale search, and starts with the item', async () => {
    const rows = await mocks.store!.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    await act(async () => {
      root.render(
        <>
          <TasksRow rows={[...rows]} />
          <GitHubItemDialog
            workItem={rows[0]}
            repoPath={repo.path}
            repoId={repo.id}
            sourceContext={source}
            onUse={mocks.onUse}
            onClose={() => {}}
          />
        </>
      )
    })
    await click('Assign me')
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(text('tasks')).toBe('alice')
    expect(text('dialog')).toBe('alice')
    const stale = await mocks
      .store!.getState()
      .fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    expect(stale[0].assignees?.map((u) => u.login)).toEqual(['alice'])
    await click('Start')
    expect(mocks.onUse).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }))
  })
})
