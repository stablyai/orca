// @vitest-environment happy-dom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '@/store/slices/store-session-test-harness'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const clipboard = vi.fn(async () => {})
const wt = makeWorktree({
  id: 'wt-1',
  repoId: TEST_REPO.id,
  branch: 'refs/heads/feature/composer',
  hostId: 'local'
})

beforeEach(() => {
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: clipboard } }
  })
  clipboard.mockClear()
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [wt] },
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [wt.id]: [makeTab({ id: 'tab-1', worktreeId: wt.id })] },
    unifiedTabsByWorktree: {},
    activeWorktreeId: wt.id,
    activeWorkspaceExecutionHostId: 'local'
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Footer() {
  return (
    <TooltipProvider>
      <NativeChatComposerWorkspace terminalTabId="tab-1" />
    </TooltipProvider>
  )
}

describe('chat composer workspace', () => {
  it('shows and copies the current branch, then follows the sidebar identity after checkout', async () => {
    render(<Footer />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy feature/composer' }))
    expect(clipboard).toHaveBeenCalledWith('feature/composer')
    await act(async () => {})
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: 'refs/heads/main' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy main' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy feature/composer' })).toBeNull()
  })

  it('distinguishes detached HEAD and never invents a branch for a folder', () => {
    useAppStore.setState({
      worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: '', head: 'a1b2c3d4e5f6' }] }
    })
    render(<Footer />)
    expect(screen.getByRole('button', { name: 'Copy Detached HEAD · a1b2c3d' })).toBeTruthy()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: '', head: '' }] }
      })
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not render for unrelated store writes or another workspace branch update', () => {
    const commits = vi.fn()
    render(
      <Profiler id="footer" onRender={commits}>
        <Footer />
      </Profiler>
    )
    commits.mockClear()
    act(() => useAppStore.setState({ activeWorktreeId: 'other' }))
    expect(commits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          [TEST_REPO.id]: [
            wt,
            makeWorktree({ id: 'other', repoId: TEST_REPO.id, branch: 'other-branch' })
          ]
        }
      })
    )
    expect(commits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: 'refs/heads/changed' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy changed' })).toBeTruthy()
    expect(commits).toHaveBeenCalledTimes(1)
  })

  it('keeps same-ID host copies separate and leaves the other host unrendered', () => {
    const remote = { ...wt, hostId: 'runtime:box' as const, branch: 'refs/heads/remote-branch' }
    useAppStore.setState({
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'runtime:box' }],
      worktreesByRepo: { [TEST_REPO.id]: [wt, remote] }
    })
    const localCommits = vi.fn()
    render(
      <TooltipProvider>
        <Profiler id="local" onRender={localCommits}>
          <NativeChatComposerWorkspace terminalTabId="tab-1" />
        </Profiler>
        <NativeChatComposerWorkspace
          terminalTabId="remote-tab"
          structuredTransport={{ worktreeId: wt.id, runtimeEnvironmentId: 'box' }}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole('button', { name: 'Copy feature/composer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy remote-branch' })).toBeTruthy()
    localCommits.mockClear()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [wt, { ...remote, branch: 'refs/heads/remote-new' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy remote-new' })).toBeTruthy()
    expect(localCommits).not.toHaveBeenCalled()
  })
})
