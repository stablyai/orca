import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from './agent-status-types'
import {
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from './agent-status-worktree-attribution'
import { structuredAgentSessionPaneKey } from './agent-session/view/structured-agent-session-projection'

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

describe('agent status worktree attribution', () => {
  it('uses the pane tab before a stale worktree stamp', () => {
    expect(
      resolveAgentStatusWorktreeId(
        entry({ worktreeId: 'stale-worktree' }),
        new Map([['tab-1', 'current-worktree']])
      )
    ).toBe('current-worktree')
  })

  it('falls back to a parent pane tab for a pre-mirror worker', () => {
    expect(
      resolveAgentStatusWorktreeId(
        entry({
          paneKey: 'worker-tab:22222222-2222-4222-8222-222222222222',
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            parentPaneKey: 'parent-tab:1'
          }
        }),
        new Map([['parent-tab', 'parent-worktree']])
      )
    ).toBe('parent-worktree')
  })

  // A host switch can leave a chat in a tab whose id a mirrored terminal once had: that id is this
  // client's own tab, so its own workspace wins, as for any chat.
  it('reads a chat in a tab with a mirrored terminal id as this client’s tab', () => {
    const chat = { id: 'web-terminal-E0', entityId: 'S', contentType: 'agent-session' as const }
    const status = entry({
      paneKey: structuredAgentSessionPaneKey('web-terminal-E0', 'S'),
      worktreeId: 'host-worktree'
    })
    const tabs = new Map([['web-terminal-E0', 'client-worktree']])
    expect(resolveAgentStatusWorktreeId(status, tabs, undefined, chat)).toBe('client-worktree')
    expect(resolveAgentStatusWorktreeId(status, tabs)).toBe('host-worktree')
  })

  it('parses legacy numeric pane identities consistently', () => {
    expect(parseAgentStatusPaneIdentity('tab-1:7')).toEqual({ tabId: 'tab-1', paneId: '7' })
  })
})

it.each([
  { connectionId: 'host-a' },
  { paneKey: 'web-terminal-shared:11111111-1111-4111-8111-111111111111' }
])('keeps the remote owner when another workspace has the same tab ID: %o', (remote) => {
  const row = entry({ worktreeId: 'host-a-workspace', ...remote })
  const tabId = row.paneKey.split(':')[0]
  expect(resolveAgentStatusWorktreeId(row, new Map([[tabId, 'host-b-workspace']]))).toBe(
    'host-a-workspace'
  )
})
