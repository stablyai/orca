// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  mergeLinearIssueComments,
  mergeLinearIssueHydration,
  useLinearIssueWorkspaceDetail
} from './linear-issue-workspace-detail-state'

const runtimeMocks = vi.hoisted(() => ({
  linearGetIssue: vi.fn(),
  linearIssueComments: vi.fn()
}))

vi.mock('@/runtime/runtime-linear-client', () => runtimeMocks)
vi.mock('@/components/LinearItemDrawer', () => ({
  initLinearIssueEditState: (selected: LinearIssue) => ({
    state: selected.state,
    priority: selected.priority,
    estimate: selected.estimate,
    assignee: selected.assignee,
    labelIds: selected.labelIds,
    labels: selected.labels
  })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function issue(id: string, title = id): LinearIssue {
  return {
    id,
    workspaceId: 'workspace-1',
    identifier: `ENG-${id}`,
    title,
    description: `${title} description`,
    url: `https://linear.app/issue/${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: ['Bug'],
    labelIds: ['label-1'],
    priority: 2,
    estimate: 3,
    updatedAt: '2026-08-01T00:00:00.000Z'
  }
}

function Harness({
  selected,
  sourceContext
}: {
  selected: LinearIssue
  sourceContext: TaskSourceContext
}): React.JSX.Element {
  const detail = useLinearIssueWorkspaceDetail({
    issue: selected,
    providerSettings: sourceContext,
    requestKey: `${sourceContext.hostId}:${selected.workspaceId}:${selected.id}`
  })
  return (
    <div>
      <span data-testid="title">{detail.displayed.title}</span>
      <span data-testid="comments">{detail.comments.map((comment) => comment.id).join(',')}</span>
      <button
        type="button"
        onClick={() =>
          detail.handleCommentAdded({
            id: 'local-comment',
            body: 'Local',
            createdAt: '2026-08-02T00:00:00.000Z'
          })
        }
      >
        Add local
      </button>
      <button type="button" onClick={() => void detail.retryComments()}>
        Retry
      </button>
    </div>
  )
}

const roots: Root[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('Linear issue workspace detail state', () => {
  it('preserves the edited fields while accepting fresh hydration data', () => {
    const current = {
      ...issue('1', 'Edited'),
      project: { id: 'project-edited', name: 'Edited project' },
      state: { name: 'In Progress', type: 'started', color: '#111111' },
      assignee: { id: 'user-1', displayName: 'Ada' },
      labels: ['Edited label'],
      labelIds: ['edited-label'],
      priority: 1,
      estimate: 8
    }
    const fetched = {
      ...issue('1', 'Server'),
      project: { id: 'project-server', name: 'Server project' },
      dueDate: '2026-09-01'
    }
    // Why: list issues never carry `project`, so hydration owns it.
    expect(mergeLinearIssueHydration(fetched, current, true)).toEqual({
      ...current,
      project: fetched.project,
      dueDate: '2026-09-01',
      updatedAt: fetched.updatedAt
    })
    expect(mergeLinearIssueHydration(fetched, current, false)).toBe(fetched)
  })

  it('deduplicates optimistic comments against provider refreshes', () => {
    const fetched: LinearComment[] = [
      { id: 'server', body: 'Server', createdAt: '2026-08-01', user: { displayName: 'Ada' } },
      { id: 'local', body: 'Local', createdAt: '2026-08-02', user: { displayName: 'You' } }
    ]
    const optimistic: LinearComment[] = [
      fetched[1],
      { id: 'pending', body: 'Pending', createdAt: '2026-08-03', user: { displayName: 'You' } }
    ]
    expect(mergeLinearIssueComments(fetched, optimistic).map((comment) => comment.id)).toEqual([
      'server',
      'local',
      'pending'
    ])
  })

  it('ignores stale issue and comment responses after the keyed identity changes', async () => {
    const sourceContext = normalizeTaskSourceContext({
      provider: 'linear',
      hostId: 'runtime:environment-1',
      projectId: 'project-group-1'
    })!
    const issueA = deferred<LinearIssue | null>()
    const issueB = deferred<LinearIssue | null>()
    const commentsA = deferred<LinearComment[]>()
    const commentsB = deferred<LinearComment[]>()
    runtimeMocks.linearGetIssue.mockImplementation((_settings, id: string) =>
      id === 'a' ? issueA.promise : issueB.promise
    )
    runtimeMocks.linearIssueComments.mockImplementation((_settings, id: string) =>
      id === 'a' ? commentsA.promise : commentsB.promise
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    act(() => {
      root.render(<Harness key="a" selected={issue('a')} sourceContext={sourceContext} />)
    })
    act(() => {
      root.render(<Harness key="b" selected={issue('b')} sourceContext={sourceContext} />)
    })
    await act(async () => {
      issueB.resolve(issue('b', 'Hydrated B'))
      commentsB.resolve([
        { id: 'comment-b', body: 'B', createdAt: '2026-08-01', user: { displayName: 'B' } }
      ])
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="title"]')?.textContent).toBe('Hydrated B')
    expect(container.querySelector('[data-testid="comments"]')?.textContent).toBe('comment-b')

    await act(async () => {
      issueA.resolve(issue('a', 'Late A'))
      commentsA.resolve([
        { id: 'comment-a', body: 'A', createdAt: '2026-08-01', user: { displayName: 'A' } }
      ])
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="title"]')?.textContent).toBe('Hydrated B')
    expect(container.querySelector('[data-testid="comments"]')?.textContent).toBe('comment-b')
    expect(runtimeMocks.linearGetIssue).toHaveBeenCalledWith(sourceContext, 'b', 'workspace-1')
    expect(runtimeMocks.linearIssueComments).toHaveBeenCalledWith(sourceContext, 'b', 'workspace-1')
  })
})
