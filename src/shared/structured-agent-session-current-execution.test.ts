import { expect, it } from 'vitest'
import { selectStructuredSessionCurrentExecution as select } from './structured-agent-session-current-execution'
import { EMPTY_STRUCTURED_AGENT_SESSION } from './structured-agent-session-reducer'
import type { AgentSessionExecutionView } from './agent-session-execution-view'

const execution: AgentSessionExecutionView = {
  sessionId: 'session',
  location: {
    executionHostId: 'local',
    workspaceId: 'folder',
    workspaceKind: 'folder',
    wslDistro: null
  },
  hostIncarnation: 'host',
  revision: 1,
  fence: 1,
  cursor: { epoch: 'epoch', sequence: 1 },
  observation: 'live',
  activity: 'working',
  control: 'native',
  turnId: 'turn',
  promptIds: [],
  recovery: false,
  historicalStatus: 'working'
}
it('revokes controls during reconnect while retaining host evidence for display', () => {
  const state = { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'ready' as const, execution }
  expect(select(state)).toMatchObject({ isWorking: true, turnId: 'turn', unverifiable: false })
  expect(select({ ...state, status: 'loading' })).toMatchObject({
    isWorking: false,
    turnId: null,
    unverifiable: true
  })
})
it('does not confuse live idle ownership or unverifiable history with work', () => {
  const state = { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'ready' as const }
  expect(
    select({ ...state, execution: { ...execution, activity: 'idle', turnId: null } })
  ).toMatchObject({ isWorking: false, turnId: null, unverifiable: false })
  expect(
    select({
      ...state,
      execution: {
        ...execution,
        observation: 'unverifiable',
        activity: 'unverifiable',
        control: 'none',
        turnId: null
      }
    })
  ).toMatchObject({ isWorking: false, turnId: null, unverifiable: true })
  expect(select(state).verificationAvailable).toBe(false)
})
