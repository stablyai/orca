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
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'

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

it('shares publication cadence across overlapping single-row invocations and resolves after publication', async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => ({ ...session(), id: `pty-${index}` }))
  list.mockResolvedValue(sessions)
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    () => new Promise((resolve) => finishes.push(() => resolve({ outcome: 'ended' })))
  )
  const removeMany = vi.spyOn(ResourceSessionInventoryCache.prototype, 'removeMany')
  const { result, rerender } = setup()
  await act(async () => {})
  rerender({ active: false })
  const settled = vi.fn()
  let pending: Promise<void>[] = []
  act(() => {
    pending = sessions.map((value) => result.current.actions.endMany([row(value)]).then(settled))
  })
  for (let wave = 0; wave < 10; wave += 1) {
    await act(async () => finishes.splice(0).forEach((finish) => finish()))
  }
  expect(kill).toHaveBeenCalledTimes(44)
  expect(removeMany).not.toHaveBeenCalled()
  expect(settled).not.toHaveBeenCalled()
  expect(result.current.actions.ending.size).toBe(100)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(removeMany).toHaveBeenCalledTimes(1)
  expect(settled).toHaveBeenCalledTimes(40)
  expect(result.current.inventory.sessionInventory.count).toBe(60)
  expect(result.current.actions.ending.size).toBe(60)
  for (let wave = 0; wave < 15; wave += 1) {
    await act(async () => finishes.splice(0).forEach((finish) => finish()))
  }
  await act(async () => Promise.all(pending).then(() => {}))
  expect(removeMany).toHaveBeenCalledTimes(2)
  expect(settled).toHaveBeenCalledTimes(100)
  expect(result.current.inventory.sessionInventory.count).toBe(0)
  expect(result.current.actions.ending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
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

it('bounds inventory publications and state copies for 10,000 staggered completions with exit events', async () => {
  const sessions = Array.from({ length: 10_000 }, (_, index) => ({
    ...session(),
    id: `pty-${index}`
  }))
  list.mockResolvedValue(sessions)
  const published = vi.fn()
  let unsubscribe = (): void => {}
  const setActive = ResourceSessionInventoryCache.prototype.setActive
  vi.spyOn(ResourceSessionInventoryCache.prototype, 'setActive').mockImplementation(function (
    this: ResourceSessionInventoryCache,
    active
  ) {
    if (active) {
      unsubscribe = this.subscribe(published)
    }
    setActive.call(this, active)
  })
  const removeMany = vi.spyOn(ResourceSessionInventoryCache.prototype, 'removeMany')
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    ({ id, expectedIncarnationId }) =>
      new Promise((resolve, reject) => {
        finishes.push(() => {
          const index = Number(id.slice(4))
          if (index % 4 === 1) {
            resolve({ outcome: 'refused', reason: 'claimed' })
          } else if (index % 4 === 2) {
            reject(new Error('Disconnected'))
          } else {
            emitExit({ id, incarnationId: expectedIncarnationId, hostId: 'local', code: 0 })
            resolve({ outcome: 'ended' })
          }
        })
      })
  )
  const { result, rerender } = setup()
  await act(async () => {})
  rerender({ active: false })
  published.mockClear()
  let pending = Promise.resolve()
  act(() => {
    pending = result.current.actions.endMany(sessions.map(row))
  })
  expect(result.current.actions.ending.size).toBe(10_000)
  let previousEnding = result.current.actions.ending
  let previousErrors = result.current.actions.errors
  let endingCopies = 0
  let errorCopies = 0
  let copiedEntries = 0
  for (let wave = 0; wave < sessions.length / 4; wave += 1) {
    await act(async () => {
      finishes.splice(0).forEach((finish) => finish())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    const { ending, errors } = result.current.actions
    if (ending !== previousEnding) {
      endingCopies += 1
      copiedEntries += ending.size
      previousEnding = ending
    }
    if (errors !== previousErrors) {
      errorCopies += 1
      copiedEntries += errors.size
      previousErrors = errors
    }
  }
  await act(async () => pending)
  expect(kill).toHaveBeenCalledTimes(10_000)
  expect(result.current.inventory.sessionInventory.count).toBe(5_000)
  expect(result.current.actions.errors.size).toBe(5_000)
  expect(result.current.actions.ending.size).toBe(0)
  expect(published.mock.calls.length).toBeLessThanOrEqual(100)
  expect(removeMany.mock.calls.length).toBeLessThanOrEqual(51)
  expect(endingCopies).toBeLessThanOrEqual(51)
  expect(errorCopies).toBeLessThanOrEqual(51)
  expect(copiedEntries).toBeLessThan(800_000)
  expect(vi.getTimerCount()).toBe(0)
  unsubscribe()
})

it('cleans buffered completions on unmount and finishes accepted queued requests without new timers', async () => {
  const sessions = Array.from({ length: 6 }, (_, index) => ({ ...session(), id: `pty-${index}` }))
  list.mockResolvedValue(sessions)
  const finishes: (() => void)[] = []
  kill.mockImplementation(
    () => new Promise((resolve) => finishes.push(() => resolve({ outcome: 'ended' })))
  )
  const removeMany = vi.spyOn(ResourceSessionInventoryCache.prototype, 'removeMany')
  const { result, unmount } = setup()
  await act(async () => {})
  let pending = Promise.resolve()
  act(() => {
    pending = result.current.actions.endMany(sessions.map(row))
  })
  await act(async () => finishes.shift()!())
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  expect(removeMany).toHaveBeenCalledTimes(1)
  await act(async () => finishes.splice(0).forEach((finish) => finish()))
  expect(kill).toHaveBeenCalledTimes(6)
  await act(async () => {
    finishes.splice(0).forEach((finish) => finish())
    await pending
  })
  expect(removeMany).toHaveBeenCalledTimes(2)
  expect(removeMany.mock.calls.map(([removed]) => removed.length)).toEqual([1, 5])
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
