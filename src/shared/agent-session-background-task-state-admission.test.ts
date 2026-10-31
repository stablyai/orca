import { describe, expect, it } from 'vitest'
import { admitAgentSessionBackgroundTaskState } from './agent-session-background-task-state-admission'

describe('a background-task frame a client admits', () => {
  it('takes a frame whose only change is incomplete tracking, both ways', () => {
    const listed = admitAgentSessionBackgroundTaskState({ state: 'monitoring', children: [] })
    const incomplete = admitAgentSessionBackgroundTaskState(
      { state: 'monitoring', children: [], incomplete: true },
      listed
    )
    expect(incomplete).not.toBe(listed)
    expect(listed).toEqual({ state: 'monitoring', children: [] })
    expect(incomplete).toEqual({ state: 'monitoring', children: [], incomplete: true })
    const complete = admitAgentSessionBackgroundTaskState(
      { state: 'monitoring', children: [] },
      incomplete
    )
    expect(complete).not.toBe(incomplete)
    expect(complete).toEqual({ state: 'monitoring', children: [] })
    expect(
      admitAgentSessionBackgroundTaskState({ state: 'monitoring', children: [] }, complete)
    ).toBe(complete)
  })
})
