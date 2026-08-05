import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { countActivityUnread } from './useActivityUnreadCount'

type ActivityUnreadSource = Parameters<typeof countActivityUnread>[0]

function entry(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Finished task',
    updatedAt: 300,
    stateStartedAt: 300,
    paneKey,
    stateHistory: [],
    ...overrides
  }
}

function retained(agentEntry: AgentStatusEntry): RetainedAgentEntry {
  return {
    entry: agentEntry,
    worktreeId: 'wt-1',
    tab: { id: agentEntry.paneKey.split(':')[0] },
    agentType: 'claude',
    startedAt: 100
  } as RetainedAgentEntry
}

function source(overrides: Partial<ActivityUnreadSource> = {}): ActivityUnreadSource {
  return {
    acknowledgedAgentsByPaneKey: {},
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    worktreesByRepo: {},
    ...overrides
  }
}

describe('countActivityUnread agent threads', () => {
  it('counts one unread thread when the pane has multiple unread events', () => {
    const paneKey = 'tab-1:leaf-1'

    expect(
      countActivityUnread(
        source({
          agentStatusByPaneKey: {
            [paneKey]: entry(paneKey, {
              stateHistory: [
                { state: 'waiting', prompt: 'Waiting', startedAt: 100 },
                { state: 'done', prompt: 'Done', startedAt: 200 }
              ]
            })
          }
        }),
        'agent-threads'
      )
    ).toBe(1)
  })

  it('dedupes a pane present in both live and retained agent state', () => {
    const paneKey = 'tab-1:leaf-1'
    const agentEntry = entry(paneKey)

    expect(
      countActivityUnread(
        source({
          agentStatusByPaneKey: { [paneKey]: agentEntry },
          retainedAgentsByPaneKey: { [paneKey]: retained(agentEntry) }
        }),
        'agent-threads'
      )
    ).toBe(1)
  })

  it('keeps a working thread unread when it has an unacknowledged prior event', () => {
    const paneKey = 'tab-1:leaf-1'

    expect(
      countActivityUnread(
        source({
          agentStatusByPaneKey: {
            [paneKey]: entry(paneKey, {
              state: 'working',
              stateStartedAt: 300,
              stateHistory: [{ state: 'done', prompt: 'Prior task', startedAt: 200 }]
            })
          }
        }),
        'agent-threads'
      )
    ).toBe(1)
  })

  it('clears a thread after its latest attention event is acknowledged', () => {
    const paneKey = 'tab-1:leaf-1'

    expect(
      countActivityUnread(
        source({
          acknowledgedAgentsByPaneKey: { [paneKey]: 400 },
          agentStatusByPaneKey: {
            [paneKey]: entry(paneKey, {
              stateHistory: [{ state: 'waiting', prompt: 'Waiting', startedAt: 200 }]
            })
          }
        }),
        'agent-threads'
      )
    ).toBe(0)
  })

  it('preserves event counting for the Activity titlebar', () => {
    const paneKey = 'tab-1:leaf-1'

    expect(
      countActivityUnread(
        source({
          agentStatusByPaneKey: {
            [paneKey]: entry(paneKey, {
              stateHistory: [
                { state: 'waiting', prompt: 'Waiting', startedAt: 100 },
                { state: 'done', prompt: 'Done', startedAt: 200 }
              ]
            })
          }
        }),
        'agent-events'
      )
    ).toBe(3)
  })

  it('preserves worktree and current-agent counting for the sidebar badge', () => {
    const paneKey = 'tab-1:leaf-1'

    expect(
      countActivityUnread(
        source({
          agentStatusByPaneKey: { [paneKey]: entry(paneKey) },
          worktreesByRepo: {
            repo: [{ id: 'wt-1', createdAt: 100, isUnread: true }]
          } as unknown as ActivityUnreadSource['worktreesByRepo']
        }),
        'sidebar-badge'
      )
    ).toBe(2)
  })
})
