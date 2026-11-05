// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/ui/dropdown-menu', () => {
  // Radix keeps the selection callback on the group, so the mocked items need it too.
  let onRadioValueChange: ((value: string) => void) | undefined
  return {
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
    DropdownMenuRadioGroup: ({
      children,
      onValueChange
    }: {
      children: ReactNode
      onValueChange?: (value: string) => void
    }) => {
      onRadioValueChange = onValueChange
      return <>{children}</>
    },
    DropdownMenuRadioItem: ({
      children,
      value,
      onSelect
    }: {
      children: ReactNode
      value?: string
      onSelect?: (event: Event) => void
    }) => (
      <button
        type="button"
        role="menuitemradio"
        onClick={() => {
          onSelect?.({ preventDefault: () => {} } as unknown as Event)
          if (value !== undefined) {
            onRadioValueChange?.(value)
          }
        }}
      >
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
  }
})
import type { PRComment } from '../../../../../../shared/github/comment-types'
import type { PRCommentGroup } from '../../../../../../shared/source-control/review-comments/pr-comment-groups'
import {
  clearPRCommentsListSelectionsForTests,
  type PRCommentsListSelectionClearRequest
} from './pr-comments-list-selection'
import { PRCommentsList } from './comments-list'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  clearPRCommentsListSelectionsForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  clearPRCommentsListSelectionsForTests()
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
  strictMode?: boolean
  onResolveSelectedCommentsWithAI?: (groups: PRCommentGroup[]) => void
  clearRequest?: PRCommentsListSelectionClearRequest | null
}): void {
  const list = (
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
  act(() => {
    root.render(props.strictMode ? <StrictMode>{list}</StrictMode> : list)
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

describe('PRCommentsList comment resolution selection', () => {
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

    expect(hasButton('Send 1 queued comment to AI')).toBe(true)

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

    expect(hasButton('Send 1 queued comment to AI')).toBe(false)
    expect(container.querySelector('button[role="checkbox"]')).toBeNull()
  })
})
