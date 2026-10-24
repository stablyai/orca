// @vitest-environment happy-dom

import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { useAppStore } from '@/store'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publishWindowState: vi.fn(async () => undefined),
  onWindowStateRequested: vi.fn((_callback: () => void) => vi.fn()),
  onWindowClosed: vi.fn((_callback: () => void) => vi.fn()),
  onRevealWorktree: vi.fn((_callback: (worktreeId: string, executionHostId?: string) => void) =>
    vi.fn()
  ),
  activateAndRevealWorktree: vi.fn(),
  onWorktreeRefreshRequested: vi.fn(() => vi.fn()),
  onWindowAnalysis: vi.fn(() => vi.fn())
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('./space-window-state', () => ({
  pickSpaceWindowState: (state: unknown) => state,
  spaceWindowStateChanged: (previous: unknown, next: unknown) => previous !== next
}))

import { SpaceWindowStatePublisher } from './SpaceWindowStatePublisher'

describe('SpaceWindowStatePublisher', () => {
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        workspaceSpace: {
          publishWindowState: mocks.publishWindowState,
          onWindowStateRequested: mocks.onWindowStateRequested,
          onWindowClosed: mocks.onWindowClosed,
          onRevealWorktree: mocks.onRevealWorktree,
          onWorktreeRefreshRequested: mocks.onWorktreeRefreshRequested,
          onWindowAnalysis: mocks.onWindowAnalysis
        }
      }
    })
    root = createRoot(document.createElement('div'))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('publishes only while Space is open and stops watching on close', async () => {
    const owner = getAgentStatusOwner(useAppStore),
      watch = owner.subscribeTransitions
    const subscribe = vi
      .spyOn(owner, 'subscribeTransitions')
      .mockImplementation((listener) => vi.fn(watch(listener)))
    await act(async () => root.render(<SpaceWindowStatePublisher />))
    expect(subscribe).not.toHaveBeenCalled()
    expect(mocks.publishWindowState).not.toHaveBeenCalled()

    await act(async () => mocks.onWindowStateRequested.mock.calls[0][0]())
    expect(subscribe).toHaveBeenCalledOnce()
    expect(mocks.publishWindowState).toHaveBeenCalledOnce()

    const offStore = subscribe.mock.results[0].value
    await act(async () => useAppStore.setState({ sortEpoch: useAppStore.getState().sortEpoch + 1 }))
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)

    await act(async () => mocks.onWindowClosed.mock.calls[0][0]())
    expect(offStore).toHaveBeenCalledOnce()
    await act(async () => useAppStore.setState({ sortEpoch: useAppStore.getState().sortEpoch + 1 }))
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)
  })

  it('reveals a workspace on its selected execution host', async () => {
    await act(async () => root.render(<SpaceWindowStatePublisher />))

    await act(async () => mocks.onRevealWorktree.mock.calls[0][0]('worktree-1', 'ssh:server-1'))

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:server-1'
    })
  })
})
