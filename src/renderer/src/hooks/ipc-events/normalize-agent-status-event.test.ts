import { expect, it } from 'vitest'
import { normalizeAgentStatusEvent } from './normalize-agent-status-event'

it('forwards the current host wakeup phase without retaining it on the next payload', () => {
  const row = {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    connectionId: null,
    receivedAt: 10,
    stateStartedAt: 5,
    state: 'working' as const,
    workingMode: 'monitoring' as const,
    mainAgent: { state: 'done' as const, stateStartedAt: 5 },
    prompt: 'watch',
    agentType: 'claude'
  }
  for (const phase of ['notification', 'finishing-turn'] as const) {
    expect(normalizeAgentStatusEvent({ ...row, claudeTaskWakeupPending: phase })).toMatchObject({
      workingMode: 'monitoring',
      mainAgent: row.mainAgent,
      claudeTaskWakeupPending: phase
    })
    expect(normalizeAgentStatusEvent(row)).not.toHaveProperty('claudeTaskWakeupPending')
  }
})
