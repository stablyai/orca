// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue, Worktree } from '../../../../shared/types'

type MockStoreState = {
  settings: Record<string, unknown>
  linearStatus: { connected: boolean } | null
  fetchLinearIssue: (id: string, workspaceId?: string | null) => Promise<LinearIssue | null>
  refreshLinearIssue: (id: string, workspaceId?: string | null) => Promise<LinearIssue | null>
}

const testState = vi.hoisted(() => ({
  activeWorktree: null as Worktree | null,
  store: {} as MockStoreState,
  fetchCalls: [] as { id: string; workspaceId?: string | null }[],
  commentCalls: 0
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: MockStoreState) => T): T => selector(testState.store)
}))
vi.mock('@/store/selectors', () => ({
  useActiveWorktree: (): Worktree | null => testState.activeWorktree
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string): string => fallback
}))
vi.mock('@/runtime/runtime-linear-client', () => ({
  linearIssueComments: async (): Promise<unknown[]> => {
    testState.commentCalls += 1
    return []
  }
}))
// The edit section and comment composer own their own Linear mutations; this
// panel test only covers target resolution, gating, and empty states.
vi.mock('@/components/LinearItemDrawer', () => ({
  LinearIssueEditSection: (): React.JSX.Element => <div data-testid="edit-section" />,
  LinearIssueCommentFooter: (): React.JSX.Element => <div data-testid="comment-footer" />,
  initLinearIssueEditState: (issue: LinearIssue) => ({
    state: issue.state,
    priority: issue.priority,
    estimate: issue.estimate,
    assignee: issue.assignee,
    labelIds: issue.labelIds,
    labels: issue.labels
  })
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }): React.JSX.Element => <div>{content}</div>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { default: LinearPanel } = await import('./LinearPanel')

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-uuid',
    identifier: 'ENG-123',
    title: 'Ship the sidebar panel',
    labels: [],
    labelIds: [],
    priority: 0,
    ...overrides
  } as LinearIssue
}

function worktree(overrides: Partial<Worktree>): Worktree {
  return { ...(overrides as Worktree) }
}

const roots: Root[] = []

function render(props: { isVisible?: boolean } = {}): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<LinearPanel {...props} />)
  })
  return container
}

beforeEach(() => {
  testState.activeWorktree = null
  testState.fetchCalls = []
  testState.commentCalls = 0
  testState.store = {
    settings: {},
    linearStatus: { connected: true },
    fetchLinearIssue: async (id, workspaceId) => {
      testState.fetchCalls.push({ id, workspaceId })
      return issue()
    },
    refreshLinearIssue: async (id, workspaceId) => {
      testState.fetchCalls.push({ id, workspaceId })
      return issue()
    }
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('LinearPanel', () => {
  it('explains itself when the workspace has no linked issue, without fetching', () => {
    testState.activeWorktree = worktree({ linkedLinearIssue: null })
    const container = render()
    expect(container.textContent).toContain('no linked Linear issue')
    expect(testState.fetchCalls).toHaveLength(0)
  })

  it('asks the user to connect Linear before trying to fetch', () => {
    testState.activeWorktree = worktree({ linkedLinearIssue: 'ENG-123' })
    testState.store.linearStatus = { connected: false }
    const container = render()
    expect(container.textContent).toContain('Connect Linear')
  })

  it('does not fetch while the panel is off screen', () => {
    testState.activeWorktree = worktree({ linkedLinearIssue: 'ENG-123' })
    render({ isVisible: false })
    expect(testState.fetchCalls).toHaveLength(0)
    expect(testState.commentCalls).toBe(0)
  })

  it('renders the linked issue and its comment composer once visible', async () => {
    testState.activeWorktree = worktree({
      linkedLinearIssue: 'ENG-123',
      linkedLinearIssueWorkspaceId: 'ws-1'
    })
    const container = render({ isVisible: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(testState.fetchCalls).toEqual([{ id: 'ENG-123', workspaceId: 'ws-1' }])
    expect(container.textContent).toContain('Ship the sidebar panel')
    expect(container.querySelector('[data-testid="edit-section"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="comment-footer"]')).not.toBeNull()
  })

  it('looks across workspaces when the link predates multi-workspace support', async () => {
    testState.activeWorktree = worktree({ linkedLinearIssue: 'ENG-9' })
    render({ isVisible: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(testState.fetchCalls).toEqual([{ id: 'ENG-9', workspaceId: 'all' }])
  })

  it('reports an unavailable issue instead of rendering an empty panel', async () => {
    testState.activeWorktree = worktree({ linkedLinearIssue: 'ENG-123' })
    testState.store.fetchLinearIssue = async () => null
    const container = render({ isVisible: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('unavailable')
  })
})
