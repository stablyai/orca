// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(() => ({ revision: 1 })),
  subscribe: vi.fn((_listener: (next: unknown, previous: unknown) => void) => vi.fn()),
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

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
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
  })

  it('publishes only while Space is open and stops watching on close', async () => {
    await act(async () => root.render(<SpaceWindowStatePublisher />))
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.publishWindowState).not.toHaveBeenCalled()

    await act(async () => mocks.onWindowStateRequested.mock.calls[0][0]())
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(mocks.publishWindowState).toHaveBeenCalledOnce()

    const onStoreChange = mocks.subscribe.mock.calls[0][0]
    const offStore = mocks.subscribe.mock.results[0].value
    await act(async () => onStoreChange({ revision: 2 }, { revision: 1 }))
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)

    await act(async () => mocks.onWindowClosed.mock.calls[0][0]())
    expect(offStore).toHaveBeenCalledOnce()
    await act(async () => onStoreChange({ revision: 3 }, { revision: 2 }))
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
