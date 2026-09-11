// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import {
  requestManualTerminalWorktreePark,
  takeAllPendingManualTerminalWorktreeParks
} from '@/lib/manual-terminal-worktree-parking'
import { useManualTerminalWorktreeParking } from './use-manual-terminal-worktree-parking'

const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))

function renderParking(renderedActiveWorktreeId: string | null) {
  return renderHook(
    (props: { renderedActiveWorktreeId: string | null }) =>
      useManualTerminalWorktreeParking({ activeView: 'terminal', ...props }),
    { initialProps: { renderedActiveWorktreeId } }
  )
}

describe('workspace-sleep park latch', () => {
  beforeEach(() => {
    takeAllPendingManualTerminalWorktreeParks()
    toastWarning.mockClear()
  })
  afterEach(cleanup)

  // Why this bypass matters: a slept workspace has no surviving PTY, so the on-demand eligibility
  // gates can never pass — and without the park its panes remount and respawn what sleep killed.
  it('parks a slept workspace that the on-demand gates would refuse', () => {
    const { result } = renderParking(null)

    act(() => requestManualTerminalWorktreePark('wt-slept', 'workspace-sleep'))

    expect(result.current).toEqual(new Set(['wt-slept']))
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('still refuses — and warns about — an ineligible manual park', () => {
    const { result } = renderParking(null)

    act(() => requestManualTerminalWorktreePark('wt-manual'))

    expect(result.current).toEqual(new Set())
    expect(toastWarning).toHaveBeenCalledOnce()
  })

  it('releases the latch when the workspace is revealed', () => {
    const { result, rerender } = renderParking(null)
    act(() => requestManualTerminalWorktreePark('wt-slept', 'workspace-sleep'))

    rerender({ renderedActiveWorktreeId: 'wt-slept' })

    expect(result.current).toEqual(new Set())
  })

  it('releases the latch on a navigation-free background wake', () => {
    const { result } = renderParking(null)
    act(() => requestManualTerminalWorktreePark('wt-slept', 'workspace-sleep'))

    act(() => {
      window.dispatchEvent(
        new CustomEvent(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, {
          detail: { worktreeId: 'wt-slept' }
        })
      )
    })

    expect(result.current).toEqual(new Set())
  })
})
