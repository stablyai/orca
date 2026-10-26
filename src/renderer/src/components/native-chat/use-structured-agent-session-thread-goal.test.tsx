// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'

const GOAL: AgentJournalThreadGoal = {
  objective: 'Ship the parser',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1_000,
  updatedAt: 1_000
}

function goalRow(sequence: number, goal: AgentJournalThreadGoal): AgentJournalRenderItem {
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      text: `Goal set: ${goal.objective}`,
      threadGoal: { state: 'set', goal }
    }
  }
}

function clearedRow(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'status', text: 'Goal cleared', threadGoal: { state: 'cleared' } }
  }
}

type MutateCall = (...args: unknown[]) => Promise<unknown>

function mutateWith(answer: MutateCall): {
  mutate: StructuredAgentSessionMutate
  calls: MutateCall
} {
  const calls = vi.fn(answer)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook never narrows the answer beyond null.
  return { mutate: calls as unknown as StructuredAgentSessionMutate, calls }
}

function harness(options: {
  journalItems?: readonly AgentJournalRenderItem[]
  support?: { current: AgentJournalThreadGoal | null }
  reported?: { current: AgentJournalThreadGoal }
  mutate?: StructuredAgentSessionMutate
  send?: (text: string) => boolean | 'queued'
}) {
  const mutate = options.mutate ?? mutateWith(async () => null).mutate
  return renderHook(() =>
    useStructuredAgentSessionThreadGoal({
      journalItems: options.journalItems ?? [],
      support: options.support,
      reported: options.reported,
      mutate,
      send: options.send ?? (() => true)
    })
  )
}

describe('useStructuredAgentSessionThreadGoal', () => {
  it('does not show a persisted goal when the host advertises neither goal field', () => {
    const fromWindow = harness({ journalItems: [goalRow(1, GOAL)] })
    expect(fromWindow.result.current).toBeNull()
  })

  it('shows a goal only the agent changes, which clears by sending it /goal clear', async () => {
    expect(harness({}).result.current).toBeNull()

    const send = vi.fn(() => true)
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = harness({ reported: { current: GOAL }, mutate, send })
    expect(result.current).toMatchObject({ goal: GOAL, hostChanges: false, pending: false })
    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(true)
    })
    expect(send).toHaveBeenCalledWith('/goal clear')
    expect(calls).not.toHaveBeenCalled()
  })

  it('reads the goal off the loaded window, and off the host answer only when the window has none', () => {
    const older = { ...GOAL, objective: 'Older goal' }
    const fromWindow = harness({ journalItems: [goalRow(1, GOAL)], support: { current: older } })
    expect(fromWindow.result.current?.goal).toEqual(GOAL)

    const fromHost = harness({ support: { current: older } })
    expect(fromHost.result.current?.goal).toEqual(older)

    const cleared = harness({ journalItems: [clearedRow(2)], support: { current: older } })
    expect(cleared.result.current?.goal).toBeNull()
  })

  it('admits Pause and Clear while Set is unsettled, keeping pending until all settle', async () => {
    const set = Promise.withResolvers<unknown>()
    const pause = Promise.withResolvers<unknown>()
    const clear = Promise.withResolvers<unknown>()
    const answers = [set, pause, clear]
    const { mutate, calls } = mutateWith(() => answers.shift()!.promise)
    const { result } = harness({ support: { current: GOAL }, mutate })
    let changes: Promise<boolean>[] = []
    act(() => {
      changes = [
        result.current!.change({ kind: 'set', objective: 'New objective' }),
        result.current!.change({ kind: 'status', status: 'paused' }),
        result.current!.change({ kind: 'clear' })
      ]
    })
    expect(calls).toHaveBeenCalledTimes(3)
    expect(result.current?.pending).toBe(true)
    await act(async () => {
      clear.resolve({ change: 'clear' })
      pause.resolve({ change: 'status' })
    })
    expect(result.current?.pending).toBe(true)
    await act(async () => {
      set.resolve({ change: 'set' })
      await expect(Promise.all(changes)).resolves.toEqual([true, true, true])
    })
    expect(result.current?.pending).toBe(false)
  })

  it('answers false for a refused or unsent change and accepts the next one', async () => {
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = harness({ support: { current: GOAL }, mutate })

    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(false)
    })
    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(false)
    })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(result.current?.pending).toBe(false)
  })
})
