// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useWorkspaceMultiplexerCompletion } from './use-workspace-multiplexer-completion'
import { FOCUS_TERMINAL_PANE_EVENT, TERMINAL_NOTIFICATION_EVENT } from '@/constants/terminal'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), getState: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { subscribe: mocks.subscribe, getState: mocks.getState }
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const paneKey = 'terminal:00000000-0000-4000-8000-000000000001'
const entry = (state: AgentStatusEntry['state'], at: number): AgentStatusEntry => ({
  state,
  stateStartedAt: at,
  updatedAt: at,
  paneKey,
  prompt: '',
  stateHistory: []
})

function setup(hiddenTab = false, reducedMotion = false) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: reducedMotion } as MediaQueryList)
  mocks.subscribe.mockReturnValue(mocks.unsubscribe)
  const root = document.createElement('div')
  const target = document.createElement('div')
  target.setAttribute(
    hiddenTab ? 'data-workspace-multiplexer-tab-id' : 'data-workspace-multiplexer-slot-id',
    'slot'
  )
  root.append(target)
  const animation = { cancel: vi.fn(), onfinish: null, id: '' }
  const animate = vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => Animation>(
    () => animation as unknown as Animation
  )
  target.animate = animate
  const { unmount } = renderHook(() => useWorkspaceMultiplexerCompletion({ current: root }))
  const snapshot = (status: AgentStatusEntry, activeView = 'multiplexer', host = 'local') => ({
    activeView,
    agentStatusByPaneKey: { [paneKey]: status },
    workspaceMultiplexer: {
      slots: [{ id: 'slot', worktreeId: 'worktree', groupId: 'group', executionHostId: host }]
    },
    unifiedTabsByWorktree: {
      worktree: [
        {
          contentType: 'terminal',
          entityId: 'terminal',
          groupId: 'group',
          executionHostId: 'local'
        }
      ]
    },
    restoredRuntimeHostIdByWorkspaceSessionKey: {}
  })
  const notify = (next: ReturnType<typeof snapshot>, prev: ReturnType<typeof snapshot>) =>
    mocks.subscribe.mock.calls[0]![0](next, prev)
  return { animate, animation, snapshot, notify, unmount }
}

it('animates a new completion only in multiplexer, ignores replay/interrupt/host mismatch, and cleans up', () => {
  const { animate, animation, snapshot, notify, unmount } = setup()
  const working = snapshot(entry('working', 1))
  const done = snapshot(entry('done', 2))
  notify(done, working)
  expect(animate).toHaveBeenCalledTimes(1)
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 3000, iterations: 1 })
  const frames = animate.mock.calls[0]![0]
  expect(frames[1]).toMatchObject({ boxShadow: frames[0].boxShadow, offset: 2 / 3 })
  expect(frames[2]).toMatchObject({ offset: 1 })
  notify(snapshot({ ...entry('done', 2), updatedAt: 3 }), done)
  notify(snapshot({ ...entry('done', 4), interrupted: true }), working)
  notify(snapshot({ ...entry('done', 4), sessionBoundary: true }), working)
  notify(snapshot(entry('done', 4), 'multiplexer', 'ssh:other'), working)
  notify(snapshot(entry('done', 4), 'terminal'), working)
  notify(done, snapshot(entry('working', 1), 'terminal'))
  expect(animate).toHaveBeenCalledTimes(1)
  expect(animation.cancel).toHaveBeenCalled()
  unmount()
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('highlights a hidden tab without motion and catches a completed turn coalesced with the next turn', () => {
  const { animate, snapshot, notify } = setup(true, true)
  notify(
    snapshot({
      ...entry('working', 3),
      stateHistory: [{ state: 'done', startedAt: 2, prompt: '' }]
    }),
    snapshot(entry('working', 1))
  )
  expect(animate).toHaveBeenCalledOnce()
  const [frames, options] = animate.mock.calls[0]!
  expect(frames[0]).toEqual(frames[1])
  expect(options).toMatchObject({ duration: 3000, iterations: 1 })
})

it('replays the visible completion rim for a notification focus request', () => {
  const { animate, snapshot } = setup()
  mocks.getState.mockReturnValue(snapshot(entry('done', 2)))
  window.dispatchEvent(
    new CustomEvent(FOCUS_TERMINAL_PANE_EVENT, {
      detail: { tabId: 'terminal', leafId: null, flashFocusedPane: true }
    })
  )
  expect(animate).toHaveBeenCalledOnce()
  expect(animate.mock.calls[0]![0][0].boxShadow).toBe('0 0 0 2px var(--status-success)')
})

it('highlights workspace-only notifications without requiring a pane identity', () => {
  const { animate, snapshot } = setup()
  mocks.getState.mockReturnValue(snapshot(entry('working', 1)))
  window.dispatchEvent(
    new CustomEvent(TERMINAL_NOTIFICATION_EVENT, {
      detail: { worktreeId: 'worktree', tabId: null }
    })
  )
  expect(animate).toHaveBeenCalledOnce()
})

it('highlights repeated notifications without stealing focus and ignores other workspaces and hidden windows', () => {
  const { animate, animation, snapshot } = setup()
  mocks.getState.mockReturnValue(snapshot(entry('working', 1)))
  const send = (worktreeId = 'worktree') =>
    window.dispatchEvent(
      new CustomEvent(TERMINAL_NOTIFICATION_EVENT, {
        detail: { worktreeId, tabId: 'terminal' }
      })
    )
  const focus = vi.fn()
  window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, focus)
  send()
  send()
  expect(animate).toHaveBeenCalledTimes(2)
  expect(animation.cancel).toHaveBeenCalledOnce()
  send('other-worktree')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  send()
  expect(animate).toHaveBeenCalledTimes(2)
  expect(focus).not.toHaveBeenCalled()
  window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, focus)
})
