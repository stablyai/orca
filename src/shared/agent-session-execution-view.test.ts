import { expect, it } from 'vitest'
import {
  joinAgentSessionExecutionView as join,
  type AgentSessionExecutionView
} from './agent-session-execution-view'
const view: AgentSessionExecutionView = {
  sessionId: 'session',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder'
  },
  hostIncarnation: 'host-a',
  revision: 1,
  fence: 2,
  cursor: { epoch: 'e', sequence: 9 },
  observation: 'live',
  activity: 'working',
  control: 'native',
  turnId: 'turn',
  promptIds: [],
  recovery: false,
  historicalStatus: 'working'
}
it('joins positive claims to history, but revokes immediately at an unchanged cursor', () => {
  expect(join(undefined, view, { epoch: 'e', sequence: 8 })).toBeUndefined()
  expect(join(undefined, view, view.cursor)).toBe(view)
  const revoked: AgentSessionExecutionView = {
    ...view,
    revision: 2,
    observation: 'unverifiable',
    control: 'none',
    turnId: null
  }
  expect(join(view, revoked, { epoch: 'e', sequence: 8 })).toBe(revoked)
  expect(join(revoked, view, view.cursor)).toBe(revoked)
})
it('does not turn missing metadata from an older host into fresh evidence', () => {
  expect(join(undefined, undefined, view.cursor)).toBeUndefined()
})
