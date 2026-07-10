// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
  }) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect?.({ preventDefault: () => {} } as unknown as Event)}
    >
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuRadioItem: ({
    children,
    onSelect
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
  }) => (
    <button
      type="button"
      role="menuitemradio"
      onClick={() => onSelect?.({ preventDefault: () => {} } as unknown as Event)}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
import type { PRComment } from '../../../../shared/types'
import type { PRCommentGroup } from '@/lib/pr-comment-groups'
import {
  clearPRCommentsListSelection,
  type PRCommentsListSelectionClearRequest
} from './pr-comments-list-selection'
import { PRCommentsList } from './checks-panel-content'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  clearPRCommentsListSelection('review:42')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this.',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
    ...overrides
  }
}

function renderList(props: {
  comments: PRComment[]
  contextKey?: string
  onResolveSelectedCommentsWithAI?: (groups: PRCommentGroup[]) => void
  clearRequest?: PRCommentsListSelectionClearRequest | null
}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <PRCommentsList
          comments={props.comments}
          commentsLoading={false}
          selectionContextKey={props.contextKey ?? 'review:42'}
          selectionClearRequest={props.clearRequest}
          onResolveSelectedCommentsWithAI={props.onResolveSelectedCommentsWithAI ?? vi.fn()}
        />
      </TooltipProvider>
    )
  })
}

function clickButton(label: string): void {
  const button =
    [...container.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute('aria-label') === label
    ) ??
    [...container.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute('aria-label')?.includes(label)
    )
  if (!button) {
    const availableButtons = [...container.querySelectorAll('button')]
      .map(
        (candidate) =>
          candidate.getAttribute('aria-label') ?? candidate.textContent?.trim() ?? '<unlabeled>'
      )
      .join(', ')
    throw new Error(`Button not found: ${label}. Available buttons: ${availableButtons}`)
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function hasButton(label: string): boolean {
  return [...container.querySelectorAll('button')].some(
    (candidate) =>
      candidate.textContent?.includes(label) ||
      candidate.getAttribute('aria-label')?.includes(label)
  )
}

function clickMenuItem(label: string): void {
  clickButton('More comment actions')
  const menuItem =
    [...document.body.querySelectorAll('[role="menuitem"]')].find((candidate) =>
      candidate.textContent?.includes(label)
    ) ??
    [...document.body.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute('aria-label')?.includes(label)
    )
  if (!menuItem) {
    throw new Error(`Menu item not found: ${label}`)
  }
  act(() => {
    menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('PRCommentsList comment resolution selection', () => {
  it('shows the bulk action when loaded unresolved comment groups are selectable', () => {
    renderList({
      comments: [
        comment({ id: 2, threadId: 'resolved', path: 'src/resolved.ts', isResolved: true }),
        comment({ id: 3, threadId: 'resolved-top-level', isResolved: true })
      ]
    })

    expect(hasButton('Send unresolved PR comments')).toBe(false)

    renderList({
      comments: [comment({ id: 4 })]
    })

    expect(hasButton('Send unresolved PR comments')).toBe(true)
    expect(container.textContent).not.toMatch(/\bAdd\b/)
  })

  it('sends all canonical groups even when the active audience filter hides the root', () => {
    const onResolveSelectedCommentsWithAI = vi.fn()
    renderList({
      comments: [
        comment({
          id: 1,
          author: 'review-bot',
          body: 'Root bot feedback.',
          threadId: 'thread-1',
          path: 'src/a.ts',
          isResolved: false,
          isBot: true
        }),
        comment({
          id: 2,
          author: 'alice',
          body: 'Human reply.',
          threadId: 'thread-1',
          path: 'src/a.ts',
          isResolved: false
        }),
        comment({
          id: 3,
          author: 'bob',
          body: 'Second thread.',
          threadId: 'thread-2',
          path: 'src/b.ts',
          isResolved: false
        })
      ],
      onResolveSelectedCommentsWithAI
    })

    clickButton('Humans')
    clickButton('Send unresolved PR comments')

    expect(onResolveSelectedCommentsWithAI).toHaveBeenCalledTimes(1)
    const selectedGroups = onResolveSelectedCommentsWithAI.mock.calls[0]?.[0] as PRCommentGroup[]
    expect(selectedGroups).toHaveLength(2)
    expect(selectedGroups[0]?.kind).toBe('thread')
    expect(selectedGroups[0]?.kind === 'thread' ? selectedGroups[0].root.body : '').toBe(
      'Root bot feedback.'
    )
    expect(selectedGroups[0]?.kind === 'thread' ? selectedGroups[0].replies[0]?.body : '').toBe(
      'Human reply.'
    )
  })

  it('lets a user queue one eligible comment thread for the agent from the visible row action', () => {
    const onResolveSelectedCommentsWithAI = vi.fn()
    renderList({
      comments: [
        comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: false }),
        comment({
          id: 2,
          author: 'bob',
          body: 'Second thread.',
          threadId: 'thread-2',
          path: 'src/b.ts',
          isResolved: false
        })
      ],
      onResolveSelectedCommentsWithAI
    })

    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)
    clickButton('Send 1 queued comments to AI')

    expect(onResolveSelectedCommentsWithAI).toHaveBeenCalledTimes(1)
    const selectedGroups = onResolveSelectedCommentsWithAI.mock.calls[0]?.[0] as PRCommentGroup[]
    expect(selectedGroups).toHaveLength(1)
    expect(selectedGroups[0]?.kind === 'thread' ? selectedGroups[0].threadId : '').toBe('thread-1')
  })

  it('lets a user queue one standalone comment for the agent from the visible row action', () => {
    const onResolveSelectedCommentsWithAI = vi.fn()
    renderList({
      comments: [
        comment({
          id: 1,
          author: 'coderabbitai',
          body: 'Review Change Stack. No actionable comments were generated.'
        })
      ],
      onResolveSelectedCommentsWithAI
    })

    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)
    clickButton('Send 1 queued comments to AI')

    expect(onResolveSelectedCommentsWithAI).toHaveBeenCalledTimes(1)
    const selectedGroups = onResolveSelectedCommentsWithAI.mock.calls[0]?.[0] as PRCommentGroup[]
    expect(selectedGroups).toHaveLength(1)
    expect(selectedGroups[0]?.kind).toBe('standalone')
    expect(selectedGroups[0]?.kind === 'standalone' ? selectedGroups[0].comment.author : '').toBe(
      'coderabbitai'
    )
  })

  it('keeps the overflow menu queue action available as a fallback', () => {
    const onResolveSelectedCommentsWithAI = vi.fn()
    renderList({
      comments: [comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: false })],
      onResolveSelectedCommentsWithAI
    })

    clickMenuItem('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)
    clickButton('Send 1 queued comments to AI')

    expect(onResolveSelectedCommentsWithAI).toHaveBeenCalledTimes(1)
  })

  it('clears the queued comment list from the header action', () => {
    renderList({
      comments: [comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: false })]
    })
    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)
    clickButton('Clear queued comments')

    expect(hasButton('Send 1 queued comments to AI')).toBe(false)
    expect(container.querySelector('button[role="checkbox"]')).toBeNull()
  })

  it('clears sent standalone bot comments from the queue when the parent confirms launch', () => {
    const comments = [
      comment({
        id: 1,
        author: 'coderabbitai',
        body: 'Review Change Stack. No actionable comments were generated.',
        isBot: true
      })
    ]
    renderList({ comments })
    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)

    renderList({
      comments,
      clearRequest: { contextKey: 'review:42', token: 1 }
    })

    expect(hasButton('Send 1 queued comments to AI')).toBe(false)
    expect(container.querySelector('button[role="checkbox"]')).toBeNull()
  })

  it('keeps queued comments selected when clearRequest is null', () => {
    const comments = [comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: false })]
    renderList({ comments })
    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)

    renderList({ comments, clearRequest: null })

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)
  })

  it('keeps a clear request pending until its review context is mounted', () => {
    const queuedComments = [
      comment({
        id: 1,
        author: 'coderabbitai',
        body: 'Review Change Stack. No actionable comments were generated.',
        isBot: true
      })
    ]
    renderList({ comments: queuedComments, contextKey: 'review:42' })
    clickButton('Queue for agent')

    expect(hasButton('Send 1 queued comments to AI')).toBe(true)

    renderList({
      comments: [comment({ id: 2, body: 'Other review comment.' })],
      contextKey: 'review:99',
      clearRequest: { contextKey: 'review:42', token: 1 }
    })
    renderList({
      comments: queuedComments,
      contextKey: 'review:42',
      clearRequest: { contextKey: 'review:42', token: 1 }
    })

    expect(hasButton('Send 1 queued comments to AI')).toBe(false)
    expect(container.querySelector('button[role="checkbox"]')).toBeNull()
  })

  it('exits selection mode when refresh leaves no eligible loaded threads', () => {
    renderList({
      comments: [comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: false })]
    })
    clickButton('Queue for agent')

    renderList({
      comments: [comment({ id: 1, threadId: 'thread-1', path: 'src/a.ts', isResolved: true })]
    })

    expect(hasButton('Send 1 queued comments to AI')).toBe(false)
  })
})
