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

it('always confirms even absent/unbound sessions, and retains the identity seen before replacement', async () => {
  const { result } = setup()
  await act(async () => {})
  act(() => result.current.actions.confirm(row(session())))
  expect(kill).not.toHaveBeenCalled()
  list.mockResolvedValue([session('B')])
  act(() => {
    void result.current.inventory.refreshSessions()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  kill.mockResolvedValue({ outcome: 'refused', reason: 'replaced' })
  await act(async () => result.current.actions.endConfirmed())
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
    act(() => result.current.actions.confirm(row(session())))
    rerender({ active: false })
    const before = list.mock.calls.length
    kill.mockResolvedValue({ outcome: 'refused', reason })
    await act(async () => result.current.actions.endConfirmed())
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
  act(() => result.current.actions.confirm(row(session())))
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.actions.endConfirmed()
    void result.current.actions.endConfirmed()
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
