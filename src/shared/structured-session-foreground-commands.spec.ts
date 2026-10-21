import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionBackgroundTaskState, AgentSessionLatestTurn } from './agent-session-wire'
import { structuredSessionForegroundCommands } from './structured-session-foreground-commands'

const pwd = 'codex-command:primary:pwd'
const server = 'codex-command:primary:server'
const running = {
  itemId: 'turn-row-2',
  observedAt: 20,
  turn: { turnId: 'turn-2', state: 'running' }
} satisfies AgentSessionLatestTurn

function tool(callId: string, turnItemId: string): AgentJournalRenderItem {
  return {
    itemId: `tool-${callId}`,
    sequence: 2,
    revision: 1,
    observedAt: 21,
    turnScope: { kind: 'turn', turnItemId },
    body: { kind: 'tool-call', callId, name: 'shell', input: null, state: 'running' }
  }
}

const roster: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  tasks: [
    { id: pwd, kind: 'command' },
    { id: server, kind: 'command' },
    { id: 'codex-command:thread:child:exec', kind: 'command' },
    { id: 'claude-task', kind: 'command' }
  ]
}

describe('structuredSessionForegroundCommands', () => {
  it('handles a roster arriving before its tool row, without hiding earlier work', () => {
    expect([
      ...structuredSessionForegroundCommands(roster, {
        items: [tool('server', 'turn-row-1')],
        latestTurn: running
      })
    ]).toEqual([pwd])
    expect([
      ...structuredSessionForegroundCommands(roster, {
        items: [tool('server', 'turn-row-1'), tool('pwd', running.itemId)],
        latestTurn: running
      })
    ]).toEqual([pwd])
  })

  it('keeps an earlier command whose journal row is outside the loaded page', () => {
    const children = [
      {
        id: 'child-server',
        providerId: server,
        kind: 'command' as const,
        state: 'working' as const,
        membership: 'live' as const,
        firstObservedAt: 10,
        observedAt: 21,
        stoppable: false,
        invocation: { invocationId: server, generation: 1 }
      }
    ]
    expect([
      ...structuredSessionForegroundCommands(
        { ...roster, children },
        {
          items: [],
          latestTurn: running
        }
      )
    ]).toEqual([pwd])
  })

  it('reveals surviving commands when the source turn ends', () => {
    expect(
      structuredSessionForegroundCommands(roster, {
        items: [],
        latestTurn: { ...running, turn: { ...running.turn, state: 'completed' } }
      }).size
    ).toBe(0)
  })

  it('uses loaded turn rows when an older host has no latest-turn field', () => {
    const turn: AgentJournalRenderItem = {
      itemId: running.itemId,
      sequence: 1,
      revision: 1,
      observedAt: 20,
      body: { kind: 'turn', ...running.turn }
    }
    expect([
      ...structuredSessionForegroundCommands(roster, {
        items: [turn, tool('server', 'turn-row-1')]
      })
    ]).toEqual([pwd])
  })
})
