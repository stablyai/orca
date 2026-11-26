import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from '../../agent-status/child-work/agent-status-child-work-view'
import { admitAgentSessionBackgroundTaskState } from './agent-session-background-task-state-admission'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { decodeCommandDetailsAvailable } from './agent-session-command-details'

function view(id: string, kind: AgentChildWorkView['kind'] = 'command'): AgentChildWorkView {
  return {
    id,
    kind,
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: `${id}-run`, generation: 1 }
  }
}

const tuple = (id: string, generation = 1) => ({
  childWorkId: id,
  invocationId: `${id}-run`,
  generation
})

describe('decodeCommandDetailsAvailable', () => {
  const children = [view('a'), view('b'), view('agent', 'agent')]

  it('keeps exact tuples of command children at their current invocation, once each', () => {
    expect(decodeCommandDetailsAvailable([tuple('a'), tuple('a'), tuple('b')], children)).toEqual([
      tuple('a'),
      tuple('b')
    ])
  })

  it('drops strangers: stale generations, unknown ids and non-command children', () => {
    expect(
      decodeCommandDetailsAvailable([tuple('a', 2), tuple('zzz'), tuple('agent')], children)
    ).toBeUndefined()
  })

  it('treats a malformed list as none available', () => {
    for (const raw of [
      'a',
      [{ ...tuple('a'), extra: 1 }],
      [{ childWorkId: 'a', invocationId: 'a-run', generation: 0 }],
      [{ childWorkId: 'a', invocationId: 'a-run', generation: 1.5 }],
      [{ childWorkId: '', invocationId: 'a-run', generation: 1 }],
      [tuple('a'), null],
      [tuple('a'), tuple('a'), tuple('a'), tuple('a')]
    ]) {
      expect(decodeCommandDetailsAvailable(raw, children)).toBeUndefined()
    }
  })

  it('roster admission never keeps the list: availability is credit, decoded only by the latch', () => {
    const withList = admitAgentSessionBackgroundTaskState({
      state: 'monitoring',
      children,
      commandDetailsAvailable: [tuple('a'), tuple('zzz')]
    })
    expect(withList).not.toHaveProperty('commandDetailsAvailable')
    const withoutList = admitAgentSessionBackgroundTaskState({ state: 'monitoring', children })
    // The same roster either way: an availability-only frame changes no reader state.
    expect(backgroundTaskStatesEqual(withList, withoutList)).toBe(true)
    expect(
      admitAgentSessionBackgroundTaskState(
        { state: 'monitoring', children, commandDetailsAvailable: [tuple('a')] },
        withoutList
      )
    ).toBe(withoutList)
  })
})
