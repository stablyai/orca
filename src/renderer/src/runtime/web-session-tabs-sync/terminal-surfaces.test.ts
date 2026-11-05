import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { buildMirroredAgentTabs } from './terminal-surfaces'

describe('buildMirroredAgentTabs', () => {
  it('keeps the client focus time when a host snapshot rebuilds a chat tab', () => {
    const existing: Tab = {
      id: 'agent-session:session-1',
      entityId: 'session-1',
      groupId: 'g',
      worktreeId: 'wt',
      executionHostId: 'local',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Old title',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 100,
      lastFocusedAt: 1_700_000_000_000
    }

    const [mirrored] = buildMirroredAgentTabs(
      {
        worktree: 'wt',
        publicationEpoch: 'test',
        snapshotVersion: 2,
        activeGroupId: 'g',
        activeTabId: null,
        activeTabType: 'agent-session',
        tabs: [
          {
            type: 'agent-session',
            id: 'host-chat',
            title: 'Renamed by host',
            sessionId: 'session-1',
            agent: 'codex',
            isActive: false
          }
        ]
      },
      'local',
      new Map(),
      'g',
      0,
      [existing],
      200
    )

    expect(mirrored?.unifiedTab.label).toBe('Renamed by host')
    expect(mirrored?.unifiedTab.lastFocusedAt).toBe(1_700_000_000_000)
  })
})
