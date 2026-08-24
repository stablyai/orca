// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReviewThreadCard } from './ReviewThreadCard'
import type { DecoratedDiffComment } from './decorated-diff-comment'

function thread(overrides?: Partial<DecoratedDiffComment>): DecoratedDiffComment {
  return {
    id: 'github-pr-thread:T1',
    worktreeId: 'wt-1',
    filePath: 'a.ts',
    lineNumber: 5,
    body: '**root** body',
    createdAt: 1,
    side: 'modified',
    author: 'alice',
    createdAtLabel: '2d ago',
    reviewThread: {
      isResolved: false,
      replies: [{ id: '2', body: 'first reply', author: 'bob', createdAtLabel: '1d ago' }]
    },
    ...overrides
  }
}

function renderCard(ui: ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

afterEach(cleanup)

describe('ReviewThreadCard', () => {
  it('renders root markdown body and replies in order', () => {
    renderCard(<ReviewThreadCard comment={thread()} onContentResize={vi.fn()} />)
    expect(screen.getByText('root')).toBeInTheDocument()
    expect(screen.getByText('first reply')).toBeInTheDocument()
    expect(screen.getByText(/alice/)).toBeInTheDocument()
    expect(screen.getByText(/bob/)).toBeInTheDocument()
  })

  it('is read-only: no reply composer or mutation buttons', () => {
    renderCard(<ReviewThreadCard comment={thread()} onContentResize={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/reply/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit|delete/i })).not.toBeInTheDocument()
  })

  it('collapses resolved threads and expands on click, resizing the zone', async () => {
    const onContentResize = vi.fn()
    renderCard(
      <ReviewThreadCard
        comment={thread({
          reviewThread: {
            isResolved: true,
            replies: []
          }
        })}
        onContentResize={onContentResize}
      />
    )
    expect(screen.queryByText('root')).not.toBeInTheDocument()
    onContentResize.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /resolved/i }))
    expect(screen.getByText('root')).toBeInTheDocument()
    expect(onContentResize).toHaveBeenCalled()
  })

  it('shows a Pending badge on the viewer’s unsubmitted draft comments', () => {
    renderCard(
      <ReviewThreadCard comment={thread({ isPendingReview: true })} onContentResize={vi.fn()} />
    )
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('renders reactions as read-only chips', () => {
    renderCard(
      <ReviewThreadCard
        comment={thread({ reactions: [{ content: '+1', count: 2 }] })}
        onContentResize={vi.fn()}
      />
    )
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders suggestion previews with the thread target lines, without an Apply button', () => {
    renderCard(
      <ReviewThreadCard
        comment={thread({
          body: '```suggestion\nreplacement\n```',
          suggestionTargetLines: ['original']
        })}
        onContentResize={vi.fn()}
      />
    )
    expect(screen.getByText('Suggested change')).toBeInTheDocument()
    expect(screen.getByText('original')).toBeInTheDocument()
    expect(screen.getByText('replacement')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^apply$/i })).not.toBeInTheDocument()
  })

  it('renders suggestion previews even when target lines are unavailable', () => {
    renderCard(
      <ReviewThreadCard
        comment={thread({ body: '```suggestion\nreplacement\n```' })}
        onContentResize={vi.fn()}
      />
    )
    expect(screen.getByText('Suggested change')).toBeInTheDocument()
    expect(screen.getByText('replacement')).toBeInTheDocument()
  })
})
