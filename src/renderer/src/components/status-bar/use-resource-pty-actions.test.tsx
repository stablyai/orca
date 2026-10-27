// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type {
  PtyFencedTerminationOutcome,
  PtyFencedTerminationRequest
} from '../../../../shared/pty-fenced-termination'
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
beforeEach(() => {
  vi.useFakeTimers()
  kill.mockReset()
  list.mockReset().mockResolvedValue([session()])
  vi.stubGlobal('api', {
    pty: { killFenced: kill, listSessions: list, onSpawned: () => () => {}, onExit: () => () => {} }
  })
})
afterEach(() => {
  cleanup()
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

it.each(['attached', 'claimed', 'unverifiable', 'unsupported'] as const)(
  'retains rows and reports %s without claiming exit',
  async (reason) => {
    const { result, rerender } = setup()
    await act(async () => {})
    rerender({ active: false })
    const before = list.mock.calls.length
    kill.mockResolvedValue({ outcome: 'refused', reason })
    await act(async () => result.current.actions.endMany([row(session())]))
    expect(result.current.inventory.sessionInventory.count).toBe(1)
    expect(result.current.actions.errors.size).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(list).toHaveBeenCalledTimes(before)
  }
)

it('marks Ending once, allows an accepted action to finish while hidden, and performs no verification listing', async () => {
  let finish!: (value: PtyFencedTerminationOutcome) => void
  kill.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result, rerender } = setup()
  await act(async () => {})
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.actions.endMany([row(session())])
    void result.current.actions.endMany([row(session())])
  })
  expect(kill).toHaveBeenCalledTimes(1)
  expect(result.current.actions.ending.size).toBe(1)
  rerender({ active: false })
  const before = list.mock.calls.length
  await act(async () => {
    finish({ outcome: 'ended' })
    await pending
  })
  expect(result.current.inventory.sessionInventory.count).toBe(0)
  expect(result.current.actions.ending.size).toBe(0)
  expect(list).toHaveBeenCalledTimes(before)
})

it('continues a batch after refusals and failures, and skips unsupported or exiting sessions', async () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    ...session(),
    id: `pty-${index}`,
    fencedTermination: index !== 5,
    ...(index === 6 ? { exiting: true as const } : {})
  }))
  list.mockResolvedValue(sessions)
  kill.mockImplementation(async ({ id }) => {
    if (id === 'pty-1') {
      return { outcome: 'refused', reason: 'claimed' }
    }
    if (id === 'pty-2') {
      throw new Error('Disconnected')
    }
    return { outcome: 'ended' }
  })
  const { result, rerender } = setup()
  await act(async () => {})
  rerender({ active: false })
  await act(async () => result.current.actions.endMany(sessions.map(row)))
  expect(kill.mock.calls.map(([request]) => request.id)).toEqual([
    'pty-0',
    'pty-1',
    'pty-2',
    'pty-3',
    'pty-4'
  ])
  expect(result.current.inventory.sessionInventory.sessions.map(({ id }) => id)).toEqual([
    'pty-1',
    'pty-2',
    'pty-5',
    'pty-6'
  ])
  expect(result.current.actions.errors.size).toBe(2)
  expect(result.current.actions.ending.size).toBe(0)
})

it('reserves queued targets immediately and limits concurrent termination requests', async () => {
  const sessions = Array.from({ length: 6 }, (_, index) => ({ ...session(), id: `pty-${index}` }))
  list.mockResolvedValue(sessions)
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve({ outcome: 'ended' }))
      })
  )
  const { result, rerender } = setup()
  await act(async () => {})
  rerender({ active: false })
  let pending = Promise.resolve()
  act(() => {
    pending = result.current.actions.endMany(sessions.map(row))
    result.current.actions.end(row(sessions[5]!))
  })
  expect(kill).toHaveBeenCalledTimes(4)
  expect(result.current.actions.ending.size).toBe(6)
  await act(async () => finishes.splice(0).forEach((finish) => finish()))
  expect(kill).toHaveBeenCalledTimes(6)
  await act(async () => {
    finishes.forEach((finish) => finish())
    await pending
  })
  expect(result.current.actions.ending.size).toBe(0)
})
