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
    expect(incomplete?.incomplete).toBe(true)
    expect(
      admitAgentSessionBackgroundTaskState({ state: 'monitoring', children: [] }, incomplete)
    ).not.toBe(incomplete)
  })
})
