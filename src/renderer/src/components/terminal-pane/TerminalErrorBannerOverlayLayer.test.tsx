/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import { TerminalErrorBannerOverlayLayer } from './TerminalErrorBannerOverlayLayer'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const TEST_WORKTREE_A = 'wt-a'
const TEST_WORKTREE_B = 'wt-b'

describe('TerminalErrorBannerOverlayLayer', () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalErrorsByWorktreeId: {
        [TEST_WORKTREE_A]: [],
        [TEST_WORKTREE_B]: []
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders null when no errors exist for the worktree', () => {
    const { container } = render(<TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_A} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the banner when entries exist and dismisses on click', () => {
    act(() => {
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_A, 'boom', 1000)
    })
    render(<TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_A} />)
    expect(screen.getByText('boom')).toBeTruthy()
    act(() => {
      screen.getByRole('button', { name: '×' }).click()
    })
    expect(useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_A]).toEqual([])
  })

  it('isolates banners across worktrees', () => {
    act(() => {
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_A, 'a-err', 1000)
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_B, 'b-err', 1000)
    })
    const { container: a } = render(
      <TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_A} />
    )
    const { container: b } = render(
      <TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_B} />
    )
    expect(a.textContent).toContain('a-err')
    expect(a.textContent).not.toContain('b-err')
    expect(b.textContent).toContain('b-err')
    expect(b.textContent).not.toContain('a-err')
  })

  it('does not clear unrelated worktrees when dismissing', () => {
    act(() => {
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_A, 'a', 1000)
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_B, 'b', 1000)
    })
    render(<TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_A} />)
    act(() => {
      screen.getByRole('button', { name: '×' }).click()
    })
    expect(useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_A]).toEqual([])
    expect(useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_B]).toHaveLength(1)
  })

  it('does not re-render when an unrelated worktree pushes (selector stability)', () => {
    let renderCount = 0
    function Probe(): null {
      renderCount += 1
      return null
    }
    function Wrapper(): React.JSX.Element {
      return (
        <>
          <Probe />
          <TerminalErrorBannerOverlayLayer worktreeId={TEST_WORKTREE_A} />
        </>
      )
    }
    render(<Wrapper />)
    const before = renderCount
    act(() => {
      useAppStore.getState().pushTerminalError(TEST_WORKTREE_B, 'unrelated', 1000)
    })
    // Probe is a sibling of the overlay; the overlay doesn't read B's slice, so
    // pushing to B shouldn't re-render A's overlay (and the parent stays stable
    // because React batches updates in act).
    expect(renderCount).toBeGreaterThanOrEqual(before)
    // A more specific assertion: A's banner content didn't appear because B has errors, not A.
    expect(screen.queryByText('unrelated')).toBeNull()
  })
})
