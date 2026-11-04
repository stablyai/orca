import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_TURN_OUTCOMES } from '../../../../shared/agent-turn-outcome'
import { dashboardRowBucketProjection, readAgentRowTurnRecords } from './dashboard-row-bucket'

const PANE_KEY = 'tab:11111111-1111-4111-8111-111111111111'

describe('dashboard ended-turn presentation', () => {
  it.each([...AGENT_TURN_OUTCOMES, undefined])(
    'preserves unseen done, seen idle, and resumed working for outcome %s',
    (outcome) => {
      const ended: AgentStatusEntry = {
        paneKey: PANE_KEY,
        state: 'done',
        prompt: 'Review output before acceptance',
        updatedAt: 1000,
        stateStartedAt: 1000,
        stateHistory: [],
        agentType: 'claude',
        mainAgent: { state: 'done', outcome, stateStartedAt: 1000 }
      }
      const row = { paneKey: PANE_KEY, entry: ended, state: 'done' as const, startedAt: 1000 }
      const state = {
        agentStatusByPaneKey: { [PANE_KEY]: ended },
        retainedAgentsByPaneKey: {},
        acknowledgedAgentsByPaneKey: {}
      }
      expect(dashboardRowBucketProjection(row, readAgentRowTurnRecords(state))).toMatchObject({
        bucket: 'done',
        dotState: 'done',
        unseen: true
      })

      const seen = { ...state, acknowledgedAgentsByPaneKey: { [PANE_KEY]: 1000 } }
      expect(dashboardRowBucketProjection(row, readAgentRowTurnRecords(seen))).toMatchObject({
        bucket: 'idle',
        dotState: 'done',
        unseen: false
      })
      expect(ended.mainAgent?.outcome).toBe(outcome)

      const resumed: AgentStatusEntry = {
        ...ended,
        state: 'working',
        stateStartedAt: 2000,
        updatedAt: 2000,
        mainAgent: { state: 'working', stateStartedAt: 2000 }
      }
      const resumedRow = { ...row, entry: resumed, state: 'working' as const }
      const resumedState = { ...seen, agentStatusByPaneKey: { [PANE_KEY]: resumed } }
      expect(
        dashboardRowBucketProjection(resumedRow, readAgentRowTurnRecords(resumedState))
      ).toMatchObject({ bucket: 'working', dotState: 'working' })
      expect(resumed.mainAgent?.outcome).toBeUndefined()
    }
  )
})
