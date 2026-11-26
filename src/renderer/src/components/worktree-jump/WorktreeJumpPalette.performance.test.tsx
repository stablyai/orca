// @vitest-environment happy-dom
// Perf contract (Cmd+K first paint): at 1,900 workspaces the opening frame built and mounted every
// result section before the input could paint (~150 ms cold). The opening commit now mounts the input
// with no result rows, and the rows arrive once that frame has painted.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

const WORKSPACE_COUNT = 1900
const initialState = useAppStore.getState()

function resultRowCount(): number {
  return document.querySelectorAll('[cmdk-item]').length
}

beforeEach(() => {
  vi.useFakeTimers()
  const worktrees = Array.from({ length: WORKSPACE_COUNT }, (_, index) =>
    makeWorktree(`repo-1::/tmp/ws-${index}`, `ws-${index}`, {
      path: `/tmp/ws-${index}`,
      branch: `refs/heads/ws-${index}`,
      lastActivityAt: index
    })
  )
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': worktrees },
    activeModal: 'none'
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

it('mounts no result rows in the opening commit and fills them in after the paint', async () => {
  render(<WorktreeJumpPalette />)

  act(() => {
    useAppStore.setState({ activeModal: 'worktree-palette' })
  })
  expect(document.querySelector('[cmdk-input]')).not.toBeNull()
  expect(resultRowCount()).toBe(0)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  // The empty-query first screen for this fixture.
  expect(resultRowCount()).toBe(11)
})
