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

/** The hook reads only whether an answer is null, so a mock need not carry the generic. */
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
  mutate?: StructuredAgentSessionMutate
}) {
  const mutate = options.mutate ?? mutateWith(async () => null).mutate
  return renderHook(() =>
    useStructuredAgentSessionThreadGoal({
      journalItems: options.journalItems ?? [],
      support: options.support,
      mutate
    })
  )
}

describe('useStructuredAgentSessionThreadGoal', () => {
  it('is absent until the host reports it can change this session goal', () => {
    expect(harness({ journalItems: [goalRow(1, GOAL)] }).result.current).toBeNull()
  })

  it('reads the goal off the loaded window, and off the host answer only when the window has none', () => {
    const older = { ...GOAL, objective: 'Older goal' }
    const fromWindow = harness({ journalItems: [goalRow(1, GOAL)], support: { current: older } })
    expect(fromWindow.result.current?.goal).toEqual(GOAL)

    const fromHost = harness({ support: { current: older } })
    expect(fromHost.result.current?.goal).toEqual(older)

    // A clear in the window outranks a host answer read before it.
    const cleared = harness({ journalItems: [clearedRow(2)], support: { current: older } })
    expect(cleared.result.current?.goal).toBeNull()
  })

  it('serializes changes: a second submit while one is unsettled is answered false, not sent', async () => {
    let settle: (value: { change: 'set' } | null) => void = () => undefined
    const { mutate, calls } = mutateWith(
      () => new Promise<{ change: 'set' } | null>((resolve) => (settle = resolve))
    )
    const { result } = harness({ support: { current: null }, mutate })

    let first: Promise<boolean> = Promise.resolve(false)
    let second: Promise<boolean> = Promise.resolve(false)
    act(() => {
      first = result.current!.change({ kind: 'set', objective: 'Ship the parser' })
      second = result.current!.change({ kind: 'set', objective: 'Ship the parser' })
    })
    await expect(second).resolves.toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledWith('agentSession.threadGoal', 'agentSession.threadGoal', {
      change: { kind: 'set', objective: 'Ship the parser' }
    })
    expect(result.current?.pending).toBe(true)

    await act(async () => settle({ change: 'set' }))
    await expect(first).resolves.toBe(true)
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
