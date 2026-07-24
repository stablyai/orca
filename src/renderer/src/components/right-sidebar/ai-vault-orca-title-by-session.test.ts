import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { aiVaultProviderSessionKey } from '../../../../shared/ai-vault-session-display-title'
import type { TerminalTab } from '../../../../shared/types'
import { buildAiVaultOrcaCustomTitleByProviderKey } from './ai-vault-orca-title-by-session'

function makeTab(id: string, customTitle: string | null): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    title: 'Codex ready',
    customTitle,
    quickCommandLabel: null,
    generatedTitle: null,
    defaultTitle: 'Terminal 1',
    createdAt: 1,
    cwd: '/repo',
    shellType: null,
    splitDirection: null,
    splitWithTabId: null
  } as TerminalTab
}

function liveEntry(args: {
  paneKey: string
  tabId: string
  sessionId: string
  agentType?: AgentStatusEntry['agentType']
}): AgentStatusEntry {
  return {
    state: 'idle',
    prompt: 'task',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: args.agentType ?? 'codex',
    paneKey: args.paneKey,
    tabId: args.tabId,
    worktreeId: 'wt-1',
    stateHistory: [],
    providerSession: { key: 'session_id', id: args.sessionId }
  }
}

describe('buildAiVaultOrcaCustomTitleByProviderKey', () => {
  it('maps a live pane customTitle by provider session', () => {
    const titles = buildAiVaultOrcaCustomTitleByProviderKey({
      agentStatusByPaneKey: {
        'tab-1:leaf': liveEntry({
          paneKey: 'tab-1:leaf',
          tabId: 'tab-1',
          sessionId: 'sess-1'
        })
      },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'Patient sync')]
      }
    })

    expect(titles.get(aiVaultProviderSessionKey('codex', 'sess-1'))).toBe('Patient sync')
  })

  it('skips entries without a provider session or empty customTitle', () => {
    const titles = buildAiVaultOrcaCustomTitleByProviderKey({
      agentStatusByPaneKey: {
        'tab-1:leaf': {
          ...liveEntry({ paneKey: 'tab-1:leaf', tabId: 'tab-1', sessionId: 'sess-1' }),
          providerSession: undefined
        },
        'tab-2:leaf': liveEntry({
          paneKey: 'tab-2:leaf',
          tabId: 'tab-2',
          sessionId: 'sess-2'
        })
      },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'Ignored'), makeTab('tab-2', '   ')]
      }
    })

    expect(titles.size).toBe(0)
  })

  it('prefers live customTitle over retained/sleeping for the same provider session', () => {
    const titles = buildAiVaultOrcaCustomTitleByProviderKey({
      agentStatusByPaneKey: {
        'tab-live:leaf': liveEntry({
          paneKey: 'tab-live:leaf',
          tabId: 'tab-live',
          sessionId: 'sess-1'
        })
      },
      retainedAgentsByPaneKey: {
        'tab-old:leaf': {
          entry: liveEntry({
            paneKey: 'tab-old:leaf',
            tabId: 'tab-old',
            sessionId: 'sess-1'
          }),
          worktreeId: 'wt-1',
          tab: { id: 'tab-old' },
          agentType: 'codex',
          startedAt: 1
        }
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-sleep:leaf': {
          paneKey: 'tab-sleep:leaf',
          tabId: 'tab-sleep',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' },
          prompt: 'task',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      },
      tabsByWorktree: {
        'wt-1': [
          makeTab('tab-live', 'Live name'),
          makeTab('tab-old', 'Retained name'),
          makeTab('tab-sleep', 'Sleeping name')
        ]
      }
    })

    expect(titles.get(aiVaultProviderSessionKey('codex', 'sess-1'))).toBe('Live name')
  })

  it('falls back to retained then sleeping when live has no rename', () => {
    const retainedOnly = buildAiVaultOrcaCustomTitleByProviderKey({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        'tab-old:leaf': {
          entry: liveEntry({
            paneKey: 'tab-old:leaf',
            tabId: 'tab-old',
            sessionId: 'sess-2'
          }),
          worktreeId: 'wt-1',
          tab: { id: 'tab-old' },
          agentType: 'codex',
          startedAt: 1
        }
      },
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {
        'wt-1': [makeTab('tab-old', 'Retained name')]
      }
    })
    expect(retainedOnly.get(aiVaultProviderSessionKey('codex', 'sess-2'))).toBe('Retained name')

    const sleepingOnly = buildAiVaultOrcaCustomTitleByProviderKey({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        'tab-sleep:leaf': {
          paneKey: 'tab-sleep:leaf',
          tabId: 'tab-sleep',
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'sess-3' },
          prompt: 'task',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      },
      tabsByWorktree: {
        'wt-1': [makeTab('tab-sleep', 'Sleeping name')]
      }
    })
    expect(sleepingOnly.get(aiVaultProviderSessionKey('claude', 'sess-3'))).toBe('Sleeping name')
  })
})
