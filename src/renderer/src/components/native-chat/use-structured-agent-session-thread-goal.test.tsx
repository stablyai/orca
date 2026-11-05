// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
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
})
