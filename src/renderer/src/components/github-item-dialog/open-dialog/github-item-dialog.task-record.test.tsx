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
import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { parseTaskQuery } from '../../../../../shared/task-query'
import type { GitHubProjectTable } from '../../../../../shared/github/project-types'
import { toast } from 'sonner'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })
  return { promise, resolve, reject }
}
const bob = { login: 'bob', name: null, avatarUrl: 'bob.png' }
/** F1 input: a board fetched after the Tasks row, so its title, state and members are fresher. */
const freshBoard: GitHubProjectTable = {
  project: {
    id: 'p',
    owner: 'acme',
    ownerType: 'organization',
    number: 1,
    title: 'Board',
    url: 'https://github.com/orgs/acme/projects/1'
  },
  selectedView: {
    id: 'v',
    number: 1,
    name: 'Table',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [],
    groupByFields: [],
    sortByFields: []
  },
  rows: [
    {
      id: 'r',
      position: 0,
      itemType: 'ISSUE',
      updatedAt: '2099-01-01T00:00:00Z',
      fieldValuesByFieldId: {},
      content: {
        title: 'Renamed on GitHub',
        body: '',
        url: row.url,
        repository: 'acme/widgets',
        number: 42,
        state: 'CLOSED',
        stateReason: null,
        isDraft: null,
        parentIssue: null,
        issueType: null,
        labels: [{ name: 'triaged', color: 'abcdef' }],
        assignees: [bob]
      }
    }
  ],
  totalCount: 1,
  parentFieldDropped: false
}
let tasks: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
function TasksMutations() {
  tasks = useTaskPageGitHubWorkItemMutation({
    queryKey: 'f1',
    query: parseTaskQuery('is:open'),
    viewerLogin: 'alice',
    patchWorkItem: mocks.store!.getState().patchWorkItem
  })
  return null
}
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

  it.each([
    ['tasks', false],
    ['tasks', true],
    ['dialog', false],
    ['dialog', true]
  ] as const)(
    'a %s assignee edit from an older row changes only its own member on every copy (ok %s)',
    async (creator, ok) => {
      const rows = await mocks.store!.getState().fetchWorkItems(repo.id, repo.path, 20, '')
      const cache = mocks.store!.getState().githubTaskCache
      const raw = () =>
        Object.values(mocks.store!.getState().workItemsCache).flatMap((e) => e.data ?? [])[0]
      const shown = () => {
        const content = cache.projectTable(freshBoard, 'local').rows[0].content
        const item = cache.projectItem(raw())
        return {
          board: [
            content.title,
            content.state,
            content.labels.map((l) => l.name),
            content.assignees.map((u) => u.login)
          ],
          tasks: [item.title, item.state, item.labels, item.assignees?.map((u) => u.login)]
        }
      }
      const before = shown()
      const update = deferred<{ ok: boolean }>()
      const verification = deferred<GitHubWorkItem>()
      mocks.item.mockReturnValueOnce(verification.promise)
      mocks.update.mockReturnValue(update.promise)
      await act(async () => {
        root.render(
          <>
            <TasksMutations />
            {creator === 'dialog' && (
              <GitHubItemDialog
                workItem={rows[0]}
                repoPath={repo.path}
                repoId={repo.id}
                sourceContext={source}
                onUse={mocks.onUse}
                onClose={() => {}}
              />
            )}
          </>
        )
      })
      // The dialog's own control, or the Tasks row's assignee toggle, starts the same edit.
      const start = () =>
        tasks.run({
          item: rows[0],
          intent: { type: 'toggleAssignee', user: alice },
          sourceContext: source,
          mutate: () => update.promise,
          errorToast: 'Failed'
        })
      await (creator === 'dialog'
        ? click('Assign me')
        : act(async () => {
            void start()
            await Promise.resolve()
          }))
      const pending = {
        board: ['Renamed on GitHub', 'CLOSED', ['triaged'], ['bob', 'alice']],
        tasks: ['Assign then start', 'open', [], ['alice']]
      }
      expect(shown()).toEqual(pending)
      await act(async () => {
        if (ok) {
          update.resolve({ ok: true })
        } else {
          update.reject(new Error('denied'))
        }
        await Promise.resolve()
      })
      await settle()
      if (!ok) {
        expect(shown()).toEqual(before)
        expect(mocks.item).not.toHaveBeenCalled()
        return
      }
      expect(mocks.item).toHaveBeenCalledOnce()
      expect(shown()).toEqual(pending)
      await act(async () => verification.reject(new Error('offline')))
      await settle()
      expect(shown()).toEqual(pending)
      const truth = {
        ...row,
        title: 'Renamed on GitHub',
        state: 'closed' as const,
        labels: ['triaged'],
        assignees: [bob, alice],
        updatedAt: '2026-10-31T12:00:05Z'
      }
      mocks.item.mockResolvedValueOnce(truth)
      const stale = await mocks
        .store!.getState()
        .fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
      expect(stale[0].assignees?.map((u) => u.login)).toEqual(['alice'])
      await settle()
      expect(shown().tasks).toEqual(['Renamed on GitHub', 'closed', ['triaged'], ['bob', 'alice']])
    }
  )

  it('keeps the first ordinary load when Refresh is clicked during it and reports a strict failure once', async () => {
    const ordinary = deferred<unknown>()
    mocks.details.mockReturnValueOnce(ordinary.promise).mockRejectedValueOnce(new Error('timeline'))
    await renderDialog()
    await click('Refresh')
    expect(text('refreshing')).toBe('true')
    expect(mocks.details).toHaveBeenCalledOnce()
    ordinary.resolve({ item: row, body: 'Ordinary body', comments: [], assignees: [] })
    await settle()
    expect(mocks.details).toHaveBeenCalledTimes(2)
    expect(mocks.details.mock.calls[1][0]).toEqual(expect.objectContaining({ canonical: true }))
    expect(text('body')).toBe('Ordinary body')
    expect(node.textContent).not.toContain('Unable to load details')
    expect(text('refreshing')).toBe('false')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Unable to refresh this task. Try again.')
  })

  it('ends a Refresh waiting on the first load when the dialog closes, keeping that load', async () => {
    const ordinary = deferred<unknown>()
    mocks.details.mockReturnValueOnce(ordinary.promise)
    await renderDialog()
    await click('Refresh')
    await act(async () => root.unmount())
    ordinary.resolve({ item: row, body: 'Ordinary body', comments: [], assignees: [] })
    await settle()
    expect(mocks.details).toHaveBeenCalledOnce()
    expect([...workItemDetailsCache.values()][0]?.details?.body).toBe('Ordinary body')
    expect(toast.error).not.toHaveBeenCalled()
    root = createRoot(node)
  })
})
