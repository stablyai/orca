// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PtyListedSession } from '../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import type {
  PtyFencedTerminationOutcome,
  PtyFencedTerminationRequest
} from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import { useResourcePtyActions } from './use-resource-pty-actions'
import { useResourceSessionInventory } from './use-resource-session-inventory'
import { buildResourcePtyRows } from './resource-pty-view-model'

const session = (incarnationId = 'A'): PtyListedSession => ({
  id: 'one',
  incarnationId,
  fencedTermination: true,
  agentOwnership: 'absent',
  cwd: '/',
  title: 'Shell'
})
const row = (value: PtyListedSession) =>
  buildResourcePtyRows({
    sessions: [value],
    bindings: { tabsByWorktree: {}, ptyIdsByTabId: {}, workspaceSessionReady: true },
    repos: [],
    worktrees: [],
    projectGroups: [],
    runtimePaneTitlesByTabId: {}
  })[0]!
const kill = vi.fn<(request: PtyFencedTerminationRequest) => Promise<PtyFencedTerminationOutcome>>()
const list = vi.fn<() => Promise<PtyListedSession[]>>()
let emitExit: Parameters<typeof window.api.pty.onExit>[0]
beforeEach(() => {
  vi.useFakeTimers()
  kill.mockReset()
  list.mockReset().mockResolvedValue([session()])
  vi.stubGlobal('api', {
    pty: {
      killFenced: kill,
      listSessions: list,
      onSpawned: () => () => {},
      onExit: (listener: typeof emitExit) => {
        emitExit = listener
        return () => {}
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function setup() {
  return renderHook(
    ({ active }) => {
      const inventory = useResourceSessionInventory(true, active, true)
      return { inventory, actions: useResourcePtyActions(inventory) }
    },
    { initialProps: { active: true } }
  )
}

it('starts immediately and retains the identity seen before replacement', async () => {
  const { result } = setup()
  await act(async () => {})
  let finish!: (value: PtyFencedTerminationOutcome) => void
  kill.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  act(() => result.current.actions.end(row(session())))
  expect(kill).toHaveBeenCalledTimes(1)
  list.mockResolvedValue([session('B')])
  act(() => {
    void result.current.inventory.refreshSessions()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  await act(async () => finish({ outcome: 'refused', reason: 'replaced' }))
  expect(kill).toHaveBeenCalledWith({
    id: 'one',
    expectedIncarnationId: 'A',
    requireNoAgentOwner: true,
    requireUnattached: true
  })
  expect(result.current.inventory.sessionInventory.sessions).toEqual([session('B')])
})

it('shares four request slots across overlapping disjoint batches and direct End actions', async () => {
  const sessions = Array.from({ length: 10 }, (_, index) => ({ ...session(), id: `pty-${index}` }))
  list.mockResolvedValue(sessions)
  const finishes: (() => void)[] = []
  let active = 0
  let maximumActive = 0
  kill.mockImplementation(
    () =>
      new Promise((resolve) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        finishes.push(() => {
          active -= 1
          resolve({ outcome: 'ended' })
        })
      })
  )
  const { result, rerender } = setup()
  await act(async () => {})
  rerender({ active: false })
  let first = Promise.resolve()
  let second = Promise.resolve()
  act(() => {
    first = result.current.actions.endMany(sessions.slice(0, 5).map(row))
    second = result.current.actions.endMany(sessions.slice(5, 9).map(row))
    result.current.actions.end(row(sessions[9]!))
  })
  expect(kill).toHaveBeenCalledTimes(4)
  expect(result.current.actions.ending.size).toBe(10)
  await act(async () => finishes.splice(0).forEach((finish) => finish()))
  expect(kill).toHaveBeenCalledTimes(8)
  await act(async () => finishes.splice(0).forEach((finish) => finish()))
  expect(kill).toHaveBeenCalledTimes(10)
  await act(async () => {
    finishes.splice(0).forEach((finish) => finish())
    await Promise.all([first, second])
  })
  expect(maximumActive).toBe(4)
  expect(result.current.inventory.sessionInventory.count).toBe(0)
  expect(result.current.actions.ending.size).toBe(0)
})

it('publishes progress without listing until overlapping termination batches drain', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({ ...session(), id: `pty-${index}` }))
  let remaining = sessions
  list.mockImplementation(async () => remaining)
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    ({ id }) =>
      new Promise((resolve, reject) => {
        finishes.push(() => {
          if (id === 'pty-0') {
            resolve({ outcome: 'refused', reason: 'claimed' })
          } else if (id === 'pty-1') {
            reject(new Error('Disconnected'))
          } else {
            remaining = remaining.filter((value) => value.id !== id)
            resolve({ outcome: 'ended' })
          }
        })
      })
  )
  const { result } = setup()
  await act(async () => {})
  expect(list).toHaveBeenCalledTimes(1)
  const settled = vi.fn()
  let first = Promise.resolve()
  let second = Promise.resolve()
  act(() => {
    first = result.current.actions.endMany(sessions.slice(0, 6).map(row)).then(settled)
    second = result.current.actions.endMany(sessions.slice(6).map(row))
  })
  for (let wave = 0; wave < 2; wave += 1) {
    await act(async () => finishes.splice(0).forEach((finish) => finish()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.actions.ending.size).toBe(12 - (wave + 1) * 4)
    expect(result.current.inventory.sessionInventory.count).toBe(14 - (wave + 1) * 4)
    expect(result.current.actions.errors.size).toBe(2)
    expect(list).toHaveBeenCalledTimes(1)
  }
  expect(settled).toHaveBeenCalledTimes(1)
  const discovered = { ...session(), id: 'new-session' }
  remaining = [...remaining, discovered]
  await act(async () => {
    finishes.splice(0).forEach((finish) => finish())
    await Promise.all([first, second])
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(list).toHaveBeenCalledTimes(2)
  expect(result.current.inventory.sessionInventory.sessions).toEqual([
    sessions[0],
    sessions[1],
    discovered
  ])
  expect(result.current.actions.ending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles a completed invocation after unmount while another accepted request is still pending', async () => {
  const sessions = [session(), { ...session(), id: 'two' }]
  list.mockResolvedValue(sessions)
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    () => new Promise((resolve) => finishes.push(() => resolve({ outcome: 'ended' })))
  )
  const { result, unmount } = setup()
  await act(async () => {})
  let first = Promise.resolve()
  let second = Promise.resolve()
  act(() => {
    first = result.current.actions.endMany([row(sessions[0]!)])
    second = result.current.actions.endMany([row(sessions[1]!)])
  })
  unmount()
  await act(async () => {
    finishes[0]!()
    await first
  })
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    finishes[1]!()
    await second
  })
  expect(vi.getTimerCount()).toBe(0)
})
