// @vitest-environment happy-dom

import { Suspense, type ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

import WorktreeMetaDialog from './WorktreeMetaDialog'

const REPO_ID = 'repo-1'
const WORKTREE_ID = 'repo-1::/repo/worktrees/feature'
const initialState = useAppStore.getInitialState()

const repo: Repo = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#999',
  addedAt: 1
}
const worktree: Worktree = {
  id: WORKTREE_ID,
  repoId: REPO_ID,
  path: '/repo/worktrees/feature',
  displayName: 'Payments rework',
  branch: 'feature',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: 'blocked on review',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
let openSettled = false
let releasePending: (() => void) | null = null

/** Suspends the first render after the dialog opens so the seeding render is discarded. */
function SuspendOnFirstOpen(): null {
  const activeModal = useAppStore((s) => s.activeModal)
  if (activeModal === 'edit-meta' && !openSettled) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        openSettled = true
        resolve()
      }
    })
  }
  return null
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.setState({ repos: [repo], worktreesByRepo: { [REPO_ID]: [worktree] } })
  openSettled = false
  releasePending = null
})

afterEach(cleanup)

describe('WorktreeMetaDialog seeding', () => {
  it('seeds the inputs even when the opening render is discarded', async () => {
    render(
      <Suspense fallback={<span data-testid="fallback">loading</span>}>
        <WorktreeMetaDialog />
        <SuspendOnFirstOpen />
      </Suspense>
    )

    await act(async () => {
      useAppStore.setState({
        activeModal: 'edit-meta',
        modalData: {
          worktreeId: WORKTREE_ID,
          currentDisplayName: worktree.displayName,
          currentComment: worktree.comment,
          focus: 'comment'
        }
      })
    })
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByPlaceholderText('Custom display name...')).toHaveProperty(
      'value',
      'Payments rework'
    )
    expect(screen.getByPlaceholderText('Notes about this worktree...')).toHaveProperty(
      'value',
      'blocked on review'
    )
  })
})
