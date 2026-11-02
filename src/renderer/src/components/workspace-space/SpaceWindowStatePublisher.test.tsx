// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { isSpaceWindowState } from './space-window-state'

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(),
  subscribe: vi.fn((_listener: (next: AppState, previous: AppState) => void) => vi.fn()),
  publishWindowState: vi.fn(async (_state: unknown) => undefined),
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

import { SpaceWindowStatePublisher } from './SpaceWindowStatePublisher'

function publishedState() {
  const value = mocks.publishWindowState.mock.calls.at(-1)?.[0]
  if (!isSpaceWindowState(value)) {
    throw new Error('Expected a valid Space state publication')
  }
  return value
}

describe('SpaceWindowStatePublisher', () => {
  let root: Root
  let state: AppState

  async function update(patch: Partial<AppState>): Promise<void> {
    const previous = state
    state = { ...state, ...patch }
    mocks.getState.mockReturnValue(state)
    await act(async () => mocks.subscribe.mock.calls[0][0](state, previous))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    state = createTestStore().getState()
    mocks.getState.mockReturnValue(state)
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
    vi.unstubAllGlobals()
  })

  it('publishes only while Space is open and stops watching on close', async () => {
    await act(async () => root.render(<SpaceWindowStatePublisher />))
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.publishWindowState).not.toHaveBeenCalled()

    await act(async () => mocks.onWindowStateRequested.mock.calls[0][0]())
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(mocks.publishWindowState).toHaveBeenCalledOnce()

    const offStore = mocks.subscribe.mock.results[0].value
    await update({ agentStatusEpoch: 1 })
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)

    await update({ agentStatusEpoch: 2 })
    await act(async () => mocks.onWindowClosed.mock.calls[0][0]())
    expect(offStore).toHaveBeenCalledOnce()
    await update({ agentStatusEpoch: 3 })
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)
  })

  it.each([256 * 1024, 2560 * 1024])(
    'keeps unchanged draft bytes out of status bursts with %i bytes of text',
    async (size) => {
      state = { ...state, editorDrafts: { file: 'x'.repeat(size) } }
      mocks.getState.mockReturnValue(state)
      await act(async () => root.render(<SpaceWindowStatePublisher />))
      await act(async () => mocks.onWindowStateRequested.mock.calls[0][0]())
      let receiver = publishedState()
      expect(receiver.editorDrafts).toEqual(state.editorDrafts)
      const { editorDrafts: _drafts, ...withoutDrafts } = receiver

      for (let epoch = 1; epoch <= 20; epoch += 1) {
        await update({ agentStatusEpoch: epoch })
      }
      expect(mocks.publishWindowState).toHaveBeenCalledOnce()
      await act(async () => vi.advanceTimersByTime(100))
      expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)
      const incoming = publishedState()
      expect(Object.hasOwn(incoming, 'editorDrafts')).toBe(false)
      expect(incoming.agentStatusEpoch).toBe(20)
      expect(JSON.stringify(incoming)).toHaveLength(
        JSON.stringify({ ...withoutDrafts, agentStatusEpoch: 20 }).length
      )
      receiver = { ...receiver, ...incoming }
      expect(receiver.editorDrafts?.file).toBe(state.editorDrafts.file)

      await update({ editorDrafts: { file: 'new exact unsaved text' } })
      await act(async () => vi.advanceTimersByTime(100))
      receiver = { ...receiver, ...publishedState() }
      expect(receiver.editorDrafts).toEqual({ file: 'new exact unsaved text' })
      await update({ editorDrafts: {} })
      await act(async () => vi.advanceTimersByTime(100))
      expect(publishedState()).toHaveProperty('editorDrafts', {})
    }
  )

  it('replays exact drafts for requests and reopened windows without leaving an extra timer', async () => {
    state = { ...state, editorDrafts: { file: 'unsaved text' } }
    mocks.getState.mockReturnValue(state)
    await act(async () => root.render(<SpaceWindowStatePublisher />))
    const request = mocks.onWindowStateRequested.mock.calls[0][0]
    await act(async () => request())
    await update({ agentStatusEpoch: 1 })
    await act(async () => request())
    expect(publishedState()).toHaveProperty('editorDrafts', state.editorDrafts)
    await act(async () => vi.advanceTimersByTime(100))
    expect(mocks.publishWindowState).toHaveBeenCalledTimes(2)
    await act(async () => mocks.onWindowClosed.mock.calls[0][0]())
    await act(async () => request())
    expect(publishedState()).toHaveProperty('editorDrafts', state.editorDrafts)
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
  })

  it('sends complete drafts after a failed publication and releases listeners on unmount', async () => {
    state = { ...state, editorDrafts: { file: 'unsaved text' } }
    mocks.getState.mockReturnValue(state)
    mocks.publishWindowState.mockRejectedValueOnce(new Error('window retired'))
    await act(async () => root.render(<SpaceWindowStatePublisher />))
    await act(async () => mocks.onWindowStateRequested.mock.calls[0][0]())
    await update({ agentStatusEpoch: 1 })
    await act(async () => vi.advanceTimersByTime(100))
    expect(publishedState()).toHaveProperty('editorDrafts', state.editorDrafts)
    const offStore = mocks.subscribe.mock.results[0].value
    await act(async () => root.render(null))
    expect(offStore).toHaveBeenCalledOnce()
    expect(mocks.onWindowStateRequested.mock.results[0].value).toHaveBeenCalledOnce()
    expect(mocks.onWindowClosed.mock.results[0].value).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
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
