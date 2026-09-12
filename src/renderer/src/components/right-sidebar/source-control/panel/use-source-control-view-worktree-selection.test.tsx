// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useReducer } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MockWorktree = { id: string; repoId: string }

function worktree(id: string, repoId: string): MockWorktree {
  return { id, repoId }
}

const state = vi.hoisted(() => ({
  activeWorktreeId: 'wt-a' as string | null,
  worktreesByRepo: {
    'repo-1': [worktree('wt-a', 'repo-1'), worktree('wt-b', 'repo-1')],
    'repo-2': [worktree('wt-c', 'repo-2')]
  } as Record<string, MockWorktree[]>,
  detectedWorktreesByRepo: {} as Record<string, { worktrees: MockWorktree[] }>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))

vi.mock('@/store/selectors', () => ({}))

const { useSourceControlViewWorktreeSelection } =
  await import('./use-source-control-view-worktree-selection')

function Harness({ pinId = 'wt-b' }: { pinId?: string }): React.JSX.Element {
  const { subjectWorktreeId, setViewWorktreeId } = useSourceControlViewWorktreeSelection()
  // Why: the mocked store is a plain object (no subscription), so a non-pinning re-render is the
  // only way to make the hook re-read the mutated state.
  const [, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div>
      <span data-testid="subject">{subjectWorktreeId ?? 'null'}</span>
      <button type="button" onClick={() => setViewWorktreeId(pinId)}>
        pick
      </button>
      <button type="button" onClick={() => bump()}>
        bump
      </button>
    </div>
  )
}

afterEach(cleanup)

describe('useSourceControlViewWorktreeSelection', () => {
  it('defaults to the app-active worktree', () => {
    render(<Harness />)
    expect(screen.getByTestId('subject').textContent).toBe('wt-a')
  })

  it('pins the subject to the picked worktree', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
  })

  it('follows the app-active worktree when it switches within the same repo without a pin', () => {
    render(<Harness />)
    expect(screen.getByTestId('subject').textContent).toBe('wt-a')
    state.activeWorktreeId = 'wt-a2'
    // Why: real store updates replace the record identity; the memo keys on it.
    state.worktreesByRepo = {
      ...state.worktreesByRepo,
      'repo-1': [...state.worktreesByRepo['repo-1'], worktree('wt-a2', 'repo-1')]
    }
    // Why: the mocked store is a plain object; bump (not pick) so no pin is set while React re-reads the new active id.
    fireEvent.click(screen.getByText('bump'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-a2')
  })

  it('keeps the pin when the app-active worktree switches within the same repo', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick'))
    state.activeWorktreeId = 'wt-a2'
    // Why: real store updates replace the record identity; the memo keys on it.
    state.worktreesByRepo = {
      ...state.worktreesByRepo,
      'repo-1': [...state.worktreesByRepo['repo-1'], worktree('wt-a2', 'repo-1')]
    }
    // Why: the mocked store is a plain object; bump React with a sibling update
    // so the subscription re-reads the new active id.
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
  })

  it('follows the app-active worktree when the active repo changes', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick'))
    state.activeWorktreeId = 'wt-c'
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-c')
  })

  it('falls back to the app-active worktree when the pinned one disappears', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
    state.worktreesByRepo = {
      ...state.worktreesByRepo,
      'repo-1': state.worktreesByRepo['repo-1'].filter((entry) => entry.id !== 'wt-b')
    }
    state.activeWorktreeId = 'wt-a'
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-a')
  })

  it('accepts a pinned worktree that only exists in the detected catalog', () => {
    state.detectedWorktreesByRepo['repo-1'] = {
      worktrees: [worktree('wt-external', 'repo-1')]
    }
    render(<Harness pinId="wt-external" />)
    fireEvent.click(screen.getByText('pick'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-external')
  })
})
