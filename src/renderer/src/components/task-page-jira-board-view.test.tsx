// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  bumpProviderRuntimeSessionGeneration,
  getEnvironmentRuntimeContextKey
} from '@/lib/provider-runtime-context'

const mocks = vi.hoisted(() => ({
  transitions: vi.fn(),
  apply: vi.fn(),
  patch: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { patchJiraIssue: typeof mocks.patch }) => unknown) =>
    selector({ patchJiraIssue: mocks.patch })
}))
vi.mock('./task-page-jira-board-move', () => ({
  getJiraBoardMoveTransitions: mocks.transitions,
  applyJiraBoardMove: mocks.apply
}))

import { TaskPageJiraBoardView } from './task-page-jira-board-view'
import { TooltipProvider } from '@/components/ui/tooltip'
import { enqueueJiraIssueMutation, jiraIssueRequestScope } from './jira-issue-mutation-queue'

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project',
  hostId: 'runtime:board-owner'
}
const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'board-owner' }
const issue: JiraIssue = {
  id: '1',
  key: 'ABC-1',
  siteId: 'site-a',
  title: 'Ship the release',
  url: 'https://example.atlassian.net/browse/ABC-1',
  project: { id: 'p1', key: 'ABC', name: 'Example' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'todo', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  updatedAt: '2026-10-01T12:00:00Z',
  createdAt: '2026-10-01T12:00:00Z'
}
const transition: JiraTransition = {
  id: 'done',
  name: 'Complete',
  to: { id: 'done', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
}

function mount(
  loading = false,
  owner: RuntimeClientTarget | null = target,
  sourceContext: TaskSourceContext | null = source
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskPageJiraBoardView
        issues={[issue]}
        loading={loading}
        selectedIssue={null}
        sourceContext={sourceContext}
        target={owner}
        scopeKey="host-a"
        showSiteContext={false}
        onOpenIssue={vi.fn()}
        onStartWorkspace={vi.fn()}
        onRefresh={mocks.refresh}
        statusOrder={{
          statusIdsByColumn: [['todo'], ['done']],
          columns: [
            { name: 'To Do', statusIds: ['todo'] },
            { name: 'Done', statusIds: ['done'] }
          ]
        }}
      />
    </TooltipProvider>
  )
}

async function move(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move ABC-1' }), { key: 'ArrowDown' })
  const destination = await screen.findByRole('menuitem', { name: 'Done' })
  fireEvent.click(destination)
}

describe('Jira board moves', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transitions.mockResolvedValue([transition])
    mocks.apply.mockResolvedValue({ result: { ok: true }, latest: null })
  })

  it('moves from the keyboard menu and refreshes the execution host', async () => {
    mount()
    await move()
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(target, issue, { transitionId: 'done' })
    )
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith(
      issue.key,
      { status: transition.to },
      {
        sourceContext: source,
        siteId: 'site-a'
      }
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('queues a board move behind a detail save without stale rollback', async () => {
    const previousSave = Promise.withResolvers<{ ok: false; error: string }>()
    const scope = jiraIssueRequestScope(issue, source, {
      activeRuntimeEnvironmentId: 'board-owner'
    })
    if (!scope) {
      throw new Error('Expected source-owned mutation scope')
    }
    const detailSave = enqueueJiraIssueMutation({
      scope,
      previous: issue,
      optimistic: { status: { ...issue.status, id: 'review', name: 'Review' } },
      update: () => previousSave.promise,
      refresh: async () => null,
      patchIssue: (patch) =>
        mocks.patch(issue.key, patch, { sourceContext: source, siteId: issue.siteId })
    }).catch(() => undefined)
    mount()
    await move()
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2))
    expect(mocks.apply).not.toHaveBeenCalled()
    await act(async () => {
      previousSave.resolve({ ok: false, error: 'Earlier detail save rejected' })
      await detailSave
    })
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
    expect(mocks.patch.mock.calls.slice(2).map((call) => call[1])).toEqual([
      { status: transition.to }
    ])
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('collects a required comment before changing the status', async () => {
    mocks.transitions.mockResolvedValue([
      {
        ...transition,
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
    mount()
    await move()
    const comment = await screen.findByRole('textbox', { name: 'Comment' })
    expect(mocks.apply).not.toHaveBeenCalled()
    fireEvent.change(comment, { target: { value: 'Release checked.' } })
    const form = comment.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(target, issue, {
        transitionId: 'done',
        transitionComment: 'Release checked.'
      })
    )
  })

  it('asks which workflow action to use when a column has several actions', async () => {
    mocks.transitions.mockResolvedValue([
      transition,
      { ...transition, id: 'cancel', name: 'Cancel work' }
    ])
    mount()
    await move()
    await screen.findByRole('button', { name: 'Cancel work' })
    expect(mocks.apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(target, issue, { transitionId: 'done' })
    )
  })

  it('leaves unsupported required fields in Jira', async () => {
    mocks.transitions.mockResolvedValue([
      {
        ...transition,
        fields: [
          {
            key: 'customfield_42',
            name: 'Release approval',
            required: true,
            schema: { type: 'array' }
          }
        ]
      }
    ])
    mount()
    await move()
    await screen.findByText('Jira requires fields Orca cannot collect yet: Release approval.')
    expect(screen.getByRole('button', { name: 'Open in Jira' })).toBeTruthy()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('rolls back a rejected mutation and keeps its error available for Retry', async () => {
    mocks.apply.mockResolvedValueOnce({
      result: { ok: false, error: 'Workflow rejected the move' },
      latest: null
    })
    mount()
    await move()
    await screen.findByRole('alert')
    expect(mocks.patch.mock.calls.map((call) => call[1])).toEqual([
      { status: transition.to },
      { status: issue.status }
    ])
    expect(screen.getByRole('alert').textContent).toBe('Workflow rejected the move')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2))
  })

  it('retries metadata failures without a mutation or optimistic status change', async () => {
    mocks.transitions.mockRejectedValueOnce(new Error('Jira is offline'))
    mount()
    await move()
    expect((await screen.findByRole('alert')).textContent).toBe('Jira is offline')
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.transitions).toHaveBeenCalledTimes(2))
    expect(mocks.transitions.mock.calls[1][4]).toBe(true)
  })

  it('does not reopen or mutate after the user cancels a pending metadata request', async () => {
    let resolve: (value: JiraTransition[]) => void = () => {}
    mocks.transitions.mockReturnValue(
      new Promise<JiraTransition[]>((done) => {
        resolve = done
      })
    )
    mount()
    await move()
    await screen.findByRole('dialog')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await act(async () => {
      resolve([transition])
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('does not apply a late transition after its owning board is removed', async () => {
    let resolve: (value: JiraTransition[]) => void = () => {}
    mocks.transitions.mockReturnValue(
      new Promise<JiraTransition[]>((done) => {
        resolve = done
      })
    )
    const view = mount()
    await move()
    view.unmount()
    await act(async () => {
      resolve([transition])
      await Promise.resolve()
    })
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('disables moves while the issue collection is being replaced', () => {
    mount(true)
    expect(screen.getByRole('button', { name: 'Move ABC-1' }).hasAttribute('disabled')).toBe(true)
    expect(mocks.transitions).not.toHaveBeenCalled()
  })

  it('disables moves when the task page owner cannot be resolved', () => {
    mount(false, null)
    expect(screen.getByRole('button', { name: 'Move ABC-1' }).hasAttribute('disabled')).toBe(true)
    expect(mocks.transitions).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('loads workflow actions from the captured owner', async () => {
    mount()
    await move()
    expect(mocks.transitions.mock.calls[0][0]).toEqual(target)
  })

  it.each([
    { settlement: 'success', sourceContext: null, kind: 'default' },
    { settlement: 'failure', sourceContext: null, kind: 'default' },
    { settlement: 'success', sourceContext: source, kind: 'explicit' },
    { settlement: 'failure', sourceContext: source, kind: 'explicit' }
  ])(
    'settles a late $settlement in the $kind source after the board is removed',
    async ({ settlement, sourceContext }) => {
      const contextKey = getEnvironmentRuntimeContextKey('board-owner')
      let settle: () => void = () => {}
      mocks.apply.mockReturnValue(
        new Promise((resolve, reject) => {
          settle = () =>
            settlement === 'success'
              ? resolve({ result: { ok: true }, latest: { ...issue, status: transition.to } })
              : reject(new Error('Old owner rejected the move'))
        })
      )
      const view = mount(false, target, sourceContext)
      await move()
      await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
      expect(mocks.patch).toHaveBeenCalledTimes(1)
      view.unmount()
      bumpProviderRuntimeSessionGeneration()
      await act(async () => settle())
      expect(mocks.patch).toHaveBeenCalledTimes(2)
      expect(mocks.patch).toHaveBeenLastCalledWith(
        issue.key,
        settlement === 'success' ? { ...issue, status: transition.to } : { status: issue.status },
        {
          sourceContext,
          siteId: issue.siteId,
          ...(!sourceContext ? { contextKey } : {})
        }
      )
      expect(mocks.refresh).not.toHaveBeenCalled()
    }
  )
})
