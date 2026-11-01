// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraComment, JiraIssue, JiraTransition } from '../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '../store/types'
import type {
  JiraIssueCommentComposer,
  JiraIssueWorkspaceContent
} from './jira-issue-workspace-content'
import type { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'
import JiraIssueWorkspace from './JiraIssueWorkspace'

type PendingRead<T> = {
  target: RuntimeClientTarget
  key: string
  resolve: (value: T) => void
  reject: (error: Error) => void
}
type ComposerProps = ComponentProps<typeof JiraIssueCommentComposer>
type ContentProps = ComponentProps<typeof JiraIssueWorkspaceContent>
type MetadataProps = ComponentProps<typeof JiraIssueMetadataBar>
type JiraStoreBoundary = Pick<AppState, 'patchJiraIssue'> & {
  settings: Pick<NonNullable<AppState['settings']>, 'activeRuntimeEnvironmentId'>
}

const boundary = vi.hoisted(
  (): {
    issues: PendingRead<JiraIssue | null>[]
    comments: PendingRead<JiraComment[]>[]
    transitions: PendingRead<JiraTransition[]>[]
    composer: ComposerProps | null
    settings: JiraStoreBoundary['settings']
    content: ContentProps | null
    metadata: MetadataProps | null
  } => ({
    issues: [],
    comments: [],
    transitions: [],
    composer: null,
    settings: { activeRuntimeEnvironmentId: 'environment-1' },
    content: null,
    metadata: null
  })
)

vi.mock('@/store', () => {
  return {
    useAppStore: (select: (state: JiraStoreBoundary) => unknown) =>
      select({
        settings: boundary.settings,
        patchJiraIssue: () => {}
      })
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-jira-client', () => {
  function request<T>(
    queue: PendingRead<T>[],
    target: RuntimeClientTarget,
    key: string
  ): Promise<T> {
    return new Promise((resolve, reject) => queue.push({ target, key, resolve, reject }))
  }
  return {
    jiraGetIssueForTarget: (target: RuntimeClientTarget, key: string) =>
      request(boundary.issues, target, key),
    jiraIssueCommentsForTarget: (target: RuntimeClientTarget, key: string) =>
      request(boundary.comments, target, key),
    jiraListTransitionsForTarget: (target: RuntimeClientTarget, key: string) =>
      request(boundary.transitions, target, key),
    jiraListPrioritiesForTarget: async () => [],
    jiraListAssignableUsersForTarget: async () => [],
    jiraUpdateIssueForTarget: async () => ({ ok: true }),
    jiraAddIssueCommentForTarget: async () => ({ ok: true, id: 'added' })
  }
})
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    // Keep the owner mounted, including its closed content, so stale state is observable.
    Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <div data-open={open}>{children}</div>
    ),
    SheetContent: Content,
    SheetTitle: Content,
    SheetDescription: Content
  }
})
vi.mock('./jira-issue-workspace-chrome', () => ({
  JiraIssueWorkspaceHeader: ({ issueLoading }: { issueLoading: boolean }) => (
    <div data-testid="issue-loading">{String(issueLoading)}</div>
  ),
  JiraIssueMetadataBar: (props: MetadataProps) => (
    <div
      data-testid="transitions"
      ref={(node) => {
        boundary.metadata = node ? props : null
      }}
    >
      {props.transitions.map((transition) => transition.id).join(',')}
    </div>
  )
}))
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: (props: ComponentProps<typeof JiraIssueWorkspaceContent>) => (
    <div
      data-testid="detail"
      ref={(node) => {
        boundary.content = node ? props : null
      }}
    >
      <span data-testid="title">{props.displayed.title}</span>
      <span data-testid="labels">{props.displayed.labels.join(',')}</span>
      <span data-testid="description">{props.displayed.description}</span>
      <span data-testid="image-owner">{JSON.stringify(props.imageTarget)}</span>
      <span data-testid="comments">{props.comments.map((comment) => comment.id).join(',')}</span>
      <span data-testid="comments-loading">{String(props.commentsLoading)}</span>
      <span data-testid="comments-error">{props.commentsError}</span>
      <button type="button" onClick={props.retryComments}>
        Retry
      </button>
    </div>
  ),
  JiraIssueCommentComposer: (props: ComposerProps) => (
    <div
      ref={(node) => {
        boundary.composer = node ? props : null
      }}
    />
  )
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'runtime:environment-1'
}
let root: Root | null = null
let container: HTMLDivElement

function issue(key = 'JIR-1', title = key): JiraIssue {
  return {
    id: key,
    key,
    title,
    siteId: 'site-1',
    description: '',
    url: `https://jira.invalid/browse/${key}`,
    project: { id: 'project', key: 'PRJ', name: 'Project' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'New' },
    labels: [],
    createdAt: '2026-10-02',
    updatedAt: '2026-10-02'
  }
}

function comment(id: string): JiraComment {
  return { id, body: id, createdAt: '2026-10-02' }
}

async function render(
  selected: JiraIssue | null,
  context: TaskSourceContext | null = sourceContext
): Promise<void> {
  if (!root) {
    throw new Error('Missing React root')
  }
  const mountedRoot = root
  await act(async () => {
    mountedRoot.render(
      <JiraIssueWorkspace
        issue={selected}
        sourceContext={context}
        onUse={() => {}}
        onClose={() => {}}
      />
    )
  })
}

function take<T>(queue: PendingRead<T>[]): PendingRead<T> {
  const pending = queue.shift()
  if (!pending) {
    throw new Error('Missing pending Jira read')
  }
  return pending
}

function text(id: string): string | null | undefined {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent
}

beforeEach(() => {
  boundary.settings = { activeRuntimeEnvironmentId: 'environment-1' }
  boundary.issues.length = 0
  boundary.comments.length = 0
  boundary.transitions.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  const mountedRoot = root
  if (mountedRoot) {
    await act(async () => mountedRoot.unmount())
  }
  root = null
  await act(async () => {
    for (const pending of [...boundary.issues, ...boundary.comments, ...boundary.transitions]) {
      pending.reject(new Error('Test cleanup'))
    }
  })
  boundary.issues.length = 0
  boundary.comments.length = 0
  boundary.transitions.length = 0
  boundary.composer = null
  boundary.content = null
  boundary.metadata = null
  document.body.replaceChildren()
})

describe('Jira issue workspace image ownership', () => {
  it('keeps explicit ownership without duplicate reads when the default host changes', async () => {
    const selected = issue()
    const owner: RuntimeClientTarget = { kind: 'environment', environmentId: 'environment-1' }
    await render(selected)
    boundary.settings = { activeRuntimeEnvironmentId: 'environment-2' }
    await render(selected)
    for (const reads of [boundary.issues, boundary.comments, boundary.transitions]) {
      expect(reads).toHaveLength(1)
      expect(reads[0]?.target).toEqual(owner)
    }
    expect(text('image-owner')).toBe(JSON.stringify(owner))
  })

  it('fences late detail, comments and transitions when the same issue switches owners', async () => {
    const selected = issue()
    await render(selected)
    const oldIssue = take(boundary.issues)
    const oldComments = take(boundary.comments)
    const oldTransitions = take(boundary.transitions)
    await render(selected, { ...sourceContext, hostId: 'runtime:environment-2' })
    const nextIssue = take(boundary.issues)
    const nextComments = take(boundary.comments)
    const nextTransitions = take(boundary.transitions)
    expect(nextIssue.target).toEqual({ kind: 'environment', environmentId: 'environment-2' })
    expect(nextComments.target).toEqual(nextIssue.target)
    expect(nextTransitions.target).toEqual(nextIssue.target)
    expect(text('image-owner')).toBe(JSON.stringify(nextIssue.target))
    await act(async () => {
      oldIssue.resolve(issue('JIR-1', 'Old owner'))
      oldComments.resolve([comment('old')])
      oldTransitions.resolve([{ id: 'old', name: 'Old', to: selected.status }])
    })
    expect(text('title')).toBe('JIR-1')
    expect(text('comments')).toBe('')
    expect(text('transitions')).toBe('')
    await act(async () => {
      nextIssue.resolve(issue('JIR-1', 'New owner'))
      nextComments.resolve([comment('new')])
      nextTransitions.resolve([{ id: 'new', name: 'New', to: selected.status }])
    })
    expect(text('title')).toBe('New owner')
    expect(text('comments')).toBe('new')
    expect(text('transitions')).toBe('new')
  })

  it('uses one account owner for row-less detail, comments, transitions and images', async () => {
    await render(issue(), null)
    const detail = take(boundary.issues)
    const comments = take(boundary.comments)
    const transitions = take(boundary.transitions)
    expect(detail.target).toEqual({ kind: 'environment', environmentId: 'environment-1' })
    expect(comments.target).toBe(detail.target)
    expect(transitions.target).toBe(detail.target)
    expect(text('image-owner')).toBe(JSON.stringify(detail.target))
    await act(async () => {
      detail.resolve(null)
      comments.resolve([])
      transitions.resolve([])
    })
  })
})
