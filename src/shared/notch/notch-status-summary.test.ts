import { expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../agent-status/contracts/agent-status-ipc-payload'
import { buildNotchSummary } from './notch-status-summary'

it('retains an unread completion until visited and admits a subsequent turn without reviving replayed work', () => {
  const completed: AgentStatusIpcPayload = {
    paneKey: 'pane',
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 1000
  }
  const replay: AgentStatusIpcPayload = {
    ...completed,
    paneKey: 'replay',
    state: 'working',
    restoredUnconfirmed: true
  }
  const boundary: AgentStatusIpcPayload = {
    ...completed,
    paneKey: 'boundary',
    sessionBoundary: true
  }
  const count = (snapshot: AgentStatusIpcPayload[], at: number) =>
    buildNotchSummary({ snapshot, acknowledgedAtByPaneKey: { pane: at }, now: 3000 }).counts
  expect(count([completed, replay, boundary], 999)).toEqual({ working: 0, attention: 0, done: 1 })
  expect(count([completed, replay, boundary], 1000)).toEqual({ working: 0, attention: 0, done: 0 })
  expect(
    count([{ ...completed, receivedAt: 2000, stateStartedAt: 2000 }, replay, boundary], 1000)
  ).toEqual({ working: 0, attention: 0, done: 1 })
})

it('keeps a host-owned structured chat visible after a quiet long-running turn', () => {
  expect(
    buildNotchSummary({
      snapshot: [
        {
          paneKey: 'chat',
          tabId: 'agent-session:chat',
          state: 'working',
          prompt: '',
          connectionId: null,
          structuredHost: 'owned',
          receivedAt: 1000,
          stateStartedAt: 1000
        }
      ],
      acknowledgedAtByPaneKey: {},
      now: 4000000
    }).counts
  ).toEqual({ working: 1, attention: 0, done: 0 })
})
