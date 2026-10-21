// @vitest-environment happy-dom

import { useCallback, useState, type ComponentProps, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  JiraComment,
  JiraIssue,
  JiraMutationResult,
  JiraProjectStatusOrder,
  JiraTransition
} from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '@/store/types'
import type * as I18n from '@/i18n/i18n'
import type { JiraIssueMetadataBar } from '@/components/jira-issue-workspace-chrome'
import type { JiraIssueWorkspaceContent } from '@/components/jira-issue-workspace-content'
import JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import { TaskPageJiraBoardView } from '@/components/task-page-jira-board-view'
import { TooltipProvider } from '@/components/ui/tooltip'

type MetadataProps = ComponentProps<typeof JiraIssueMetadataBar>
type ContentProps = ComponentProps<typeof JiraIssueWorkspaceContent>
type JiraStoreBoundary = Pick<AppState, 'patchJiraIssue'> & {
  settings: Pick<NonNullable<AppState['settings']>, 'activeRuntimeEnvironmentId'>
}

const runtime = vi.hoisted(() => ({
  jiraAddIssueCommentForTarget: vi.fn(),
  jiraGetIssueForTarget: vi.fn(),
  jiraIssueCommentsForTarget: vi.fn(),
  jiraListAssignableUsersForTarget: vi.fn(),
  jiraListPrioritiesForTarget: vi.fn(),
  jiraListTransitionsForTarget: vi.fn(),
  jiraUpdateIssueForTarget: vi.fn(),
  refresh: vi.fn()
}))
const store = vi.hoisted((): JiraStoreBoundary & { statusPatches: string[] } => ({
  settings: { activeRuntimeEnvironmentId: 'board-detail-owner' },
  patchJiraIssue: () => {},
  statusPatches: []
}))

vi.mock('@/runtime/runtime-jira-client', () => runtime)
vi.mock('@/store', () => ({
  useAppStore: (select: (state: JiraStoreBoundary) => unknown) => select(store)
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
      values?.[key] === undefined ? token : String(values[key])
    )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    SheetContent: Content,
    SheetTitle: Content,
    SheetDescription: Content
  }
})
vi.mock('@/components/ui/dialog', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content
  }
})
vi.mock('@/components/jira-issue-workspace-chrome', () => ({
  JiraIssueWorkspaceHeader: () => null,
  JiraIssueMetadataBar: ({ displayed, transitions, pendingField, mutateIssue }: MetadataProps) => (
    <div>
      <output data-testid="detail-status">{displayed.status.name}</output>
      {transitions.map((transition) => (
        <button
          key={transition.id}
          type="button"
          disabled={pendingField !== null}
          onClick={() =>
            void mutateIssue(
              'transition',
              { transitionId: transition.id },
              { status: transition.to }
            )
          }
        >
          Detail {transition.name}
        </button>
      ))}
    </div>
  )
}))
vi.mock('@/components/jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: ({ comments, commentsLoading }: ContentProps) => (
    <div>
      <div data-testid="detail-comments">
        {comments.map((comment) => (
          <p key={comment.id}>{comment.body}</p>
        ))}
      </div>
      <output data-testid="detail-comments-loading">{String(commentsLoading)}</output>
    </div>
  ),
  JiraIssueCommentComposer: () => null
}))

const owner: RuntimeClientTarget = {
  kind: 'environment',
  environmentId: 'board-detail-owner'
}
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'board-detail-project',
  hostId: 'runtime:board-detail-owner'
}
const issue: JiraIssue = {
  id: 'board-detail-1',
  key: 'REGRESSION-1',
  siteId: 'board-detail-site',
  title: 'Keep the later board move',
  url: 'https://jira.invalid/browse/REGRESSION-1',
  project: { id: 'project', key: 'REGRESSION', name: 'Regression' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'todo', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  updatedAt: '2026-10-14T12:00:00Z',
  createdAt: '2026-10-14T12:00:00Z'
}
const review: JiraTransition = {
  id: 'start-review',
  name: 'Start review',
  to: { id: 'review', name: 'Review', categoryKey: 'indeterminate', categoryName: 'In Progress' }
}
const done: JiraTransition = {
  id: 'finish',
  name: 'Finish',
  to: { id: 'done', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
}
const statusOrder: JiraProjectStatusOrder = {
  statusIdsByColumn: [['todo'], ['review'], ['done']],
  columns: [
    { name: 'To Do', statusIds: ['todo'] },
    { name: 'Review', statusIds: ['review'] },
    { name: 'Done', statusIds: ['done'] }
  ]
}

// Cache patches feed both actual owners a new object for the same issue.
function StoreBackedBoardAndDetail({
  sourceContext,
  scopeKey
}: {
  sourceContext: TaskSourceContext | null
  scopeKey: string
}): React.JSX.Element {
  const [cachedIssue, setCachedIssue] = useState(issue)
  store.patchJiraIssue = useCallback<AppState['patchJiraIssue']>((key, patch) => {
    if (key !== issue.key) {
      return
    }
    if (patch.status) {
      store.statusPatches.push(patch.status.id)
    }
    setCachedIssue((current) => ({ ...current, ...patch }))
  }, [])
  return (
    <TooltipProvider>
      <output data-testid="cache-status">{cachedIssue.status.name}</output>
      <JiraIssueWorkspace
        issue={cachedIssue}
        sourceContext={sourceContext}
        onUse={() => {}}
        onClose={() => {}}
      />
      <TaskPageJiraBoardView
        issues={[cachedIssue]}
        selectedIssue={cachedIssue}
        sourceContext={sourceContext}
        target={owner}
        scopeKey={scopeKey}
        showSiteContext={false}
        statusOrder={statusOrder}
        onOpenIssue={() => {}}
        onStartWorkspace={() => {}}
        onRefresh={runtime.refresh}
      />
    </TooltipProvider>
  )
}

let finishOutstandingWrites = (): void => {}

beforeEach(() => {
  finishOutstandingWrites = () => {}
  for (const mock of Object.values(runtime)) {
    mock.mockReset()
  }
  store.statusPatches.length = 0
  store.patchJiraIssue = () => {}
  runtime.jiraIssueCommentsForTarget.mockResolvedValue([])
  runtime.jiraListAssignableUsersForTarget.mockResolvedValue([])
  runtime.jiraListPrioritiesForTarget.mockResolvedValue([])
  runtime.jiraListTransitionsForTarget.mockResolvedValue([review, done])
})

afterEach(async () => {
  await act(async () => finishOutstandingWrites())
  cleanup()
})

describe('Jira board and detail mutation integration', () => {
  it.each([
    { kind: 'explicit', sourceContext: source },
    { kind: 'default', sourceContext: null }
  ])(
    'serializes a $kind-source board move after a rejected detail status save',
    async ({ kind, sourceContext }) => {
      const detailSave = Promise.withResolvers<JiraMutationResult>()
      const boardSave = Promise.withResolvers<JiraMutationResult>()
      let serverIssue = issue
      finishOutstandingWrites = () => {
        detailSave.resolve({ ok: false, error: 'Detail status save rejected' })
        boardSave.resolve({ ok: true })
      }
      runtime.jiraGetIssueForTarget.mockImplementation(async () => serverIssue)
      runtime.jiraUpdateIssueForTarget
        .mockImplementationOnce(() => detailSave.promise)
        .mockImplementationOnce(() => boardSave.promise)
      render(
        <StoreBackedBoardAndDetail
          sourceContext={sourceContext}
          scopeKey={`board-detail-integration:${kind}`}
        />
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Detail Start review' }))
      await waitFor(() => expect(runtime.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1))
      expect(runtime.jiraUpdateIssueForTarget).toHaveBeenNthCalledWith(
        1,
        owner,
        issue.key,
        { transitionId: review.id },
        issue.siteId
      )
      expect(screen.getByTestId('cache-status').textContent).toBe('Review')
      expect(screen.getByTestId('detail-status').textContent).toBe('Review')

      fireEvent.keyDown(screen.getByRole('button', { name: `Move ${issue.key}` }), {
        key: 'ArrowDown'
      })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }))
      await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Done'))
      expect(screen.getByTestId('detail-status').textContent).toBe('Done')
      expect(runtime.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
      const queuedPatchCount = store.statusPatches.length

      await act(async () => {
        detailSave.resolve({ ok: false, error: 'Detail status save rejected' })
      })
      await waitFor(() => expect(runtime.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2))
      expect(runtime.jiraUpdateIssueForTarget).toHaveBeenNthCalledWith(
        2,
        owner,
        issue.key,
        { transitionId: done.id },
        issue.siteId
      )
      // Observe the rejection while the later provider write remains pending.
      expect(screen.getByTestId('cache-status').textContent).toBe('Done')
      expect(screen.getByTestId('detail-status').textContent).toBe('Done')
      expect(store.statusPatches.slice(queuedPatchCount)).not.toContain('todo')
      expect(store.statusPatches.slice(queuedPatchCount)).not.toContain('review')
      expect(runtime.refresh).not.toHaveBeenCalled()

      serverIssue = { ...issue, status: done.to }
      await act(async () => boardSave.resolve({ ok: true }))
      await waitFor(() => expect(runtime.refresh).toHaveBeenCalledTimes(1))
      expect(screen.getByTestId('cache-status').textContent).toBe('Done')
      expect(screen.getByTestId('detail-status').textContent).toBe('Done')
      expect(store.statusPatches.slice(queuedPatchCount)).not.toContain('todo')
      expect(store.statusPatches.slice(queuedPatchCount)).not.toContain('review')
      expect(runtime.jiraGetIssueForTarget).toHaveBeenLastCalledWith(owner, issue.key, issue.siteId)
    }
  )

  it.each([
    { kind: 'explicit', sourceContext: source, settlement: 'success' },
    { kind: 'explicit', sourceContext: source, settlement: 'rejection' },
    { kind: 'default', sourceContext: null, settlement: 'success' },
    { kind: 'default', sourceContext: null, settlement: 'rejection' }
  ])(
    'refreshes the $kind-source detail timeline only after a board comment save $settlement',
    async ({ kind, sourceContext, settlement }) => {
      const boardSave = Promise.withResolvers<JiraMutationResult>()
      let serverIssue = issue
      let serverComments: JiraComment[] = [
        { id: 'existing', body: 'Existing note', createdAt: '2026-10-14T12:00:00Z' }
      ]
      finishOutstandingWrites = () => boardSave.resolve({ ok: true })
      runtime.jiraGetIssueForTarget.mockImplementation(async () => serverIssue)
      runtime.jiraIssueCommentsForTarget.mockImplementation(async () => serverComments)
      runtime.jiraUpdateIssueForTarget.mockReturnValue(boardSave.promise)
      runtime.jiraListTransitionsForTarget.mockResolvedValue([
        {
          ...done,
          fields: [
            {
              key: 'comment',
              name: 'Comment',
              required: true,
              schema: { system: 'comment', type: 'string' }
            }
          ]
        }
      ])
      render(
        <StoreBackedBoardAndDetail
          sourceContext={sourceContext}
          scopeKey={`board-comment-integration:${kind}:${settlement}`}
        />
      )
      await screen.findByText('Existing note')
      expect(runtime.jiraIssueCommentsForTarget).toHaveBeenCalledExactlyOnceWith(
        owner,
        issue.key,
        issue.siteId
      )
      fireEvent.keyDown(screen.getByRole('button', { name: `Move ${issue.key}` }), {
        key: 'ArrowDown'
      })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }))
      const commentInput = await screen.findByRole('textbox', { name: 'Comment' })
      expect(runtime.jiraUpdateIssueForTarget).not.toHaveBeenCalled()
      fireEvent.change(commentInput, { target: { value: 'Verified from the board' } })
      const form = commentInput.closest('form')
      if (!form) {
        throw new Error('Expected the board transition form')
      }
      fireEvent.submit(form)
      await waitFor(() => expect(runtime.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1))
      expect(runtime.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
        owner,
        issue.key,
        { transitionId: done.id, transitionComment: 'Verified from the board' },
        issue.siteId
      )
      expect(runtime.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('detail-comments').textContent).not.toContain(
        'Verified from the board'
      )

      if (settlement === 'success') {
        serverIssue = { ...issue, status: done.to }
        serverComments = [
          ...serverComments,
          {
            id: 'board-comment',
            body: 'Verified from the board',
            createdAt: '2026-10-14T12:01:00Z'
          }
        ]
        await act(async () => boardSave.resolve({ ok: true }))
        await screen.findByText('Verified from the board')
        expect(runtime.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(2)
        expect(runtime.refresh).toHaveBeenCalledTimes(1)
      } else {
        await act(async () => boardSave.resolve({ ok: false, error: 'Board transition rejected' }))
        expect((await screen.findByRole('alert')).textContent).toBe('Board transition rejected')
        expect(runtime.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('detail-comments').textContent).not.toContain(
          'Verified from the board'
        )
        expect(runtime.refresh).not.toHaveBeenCalled()
        expect(screen.getByDisplayValue('Verified from the board')).toBeDefined()
        expect(screen.getByRole('button', { name: 'Change status' }).hasAttribute('disabled')).toBe(
          false
        )
      }
      expect(screen.getByText('Existing note')).toBeDefined()
      expect(screen.getByTestId('detail-comments-loading').textContent).toBe('false')
      expect(runtime.jiraIssueCommentsForTarget.mock.calls).toEqual(
        Array.from({ length: settlement === 'success' ? 2 : 1 }, () => [
          owner,
          issue.key,
          issue.siteId
        ])
      )
      expect(runtime.jiraAddIssueCommentForTarget).not.toHaveBeenCalled()
    }
  )
})
