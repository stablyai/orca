import { expect, it } from 'vitest'
import { agentPaneSleepStatus } from './agent-pane-sleep-status'

it('keeps a finished main agent verdict when sleep interrupts its children', () => {
  const finished = { state: 'done', stateStartedAt: 10 } as const
  expect(agentPaneSleepStatus({ state: 'working', mainAgent: finished }, 50)).toEqual({
    state: 'done',
    mainAgent: finished
  })
  expect(
    agentPaneSleepStatus(
      { state: 'working', mainAgent: { state: 'working', stateStartedAt: 10 } },
      50
    )
  ).toEqual({
    state: 'done',
    interrupted: true,
    mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 50 }
  })
})
