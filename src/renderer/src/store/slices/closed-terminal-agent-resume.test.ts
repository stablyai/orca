import { describe, expect, it } from 'vitest'
import { extractClosedTerminalAgentResume } from './closed-terminal-agent-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

function liveEntry(
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>
): AgentStatusEntry {
  return {
    state: 'idle',
    prompt: '',
    updatedAt: 100,
    stateStartedAt: 100,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    ...overrides
  }
}

describe('extractClosedTerminalAgentResume', () => {
  it('returns the newest live resumable agent for the closed tab', () => {
    const result = extractClosedTerminalAgentResume({
      tabId: 'tab-1',
      agentStatusByPaneKey: {
        'tab-1:leaf-a': liveEntry({
          paneKey: 'tab-1:leaf-a',
          updatedAt: 10,
          providerSession: { key: 'session_id', id: 'old' }
        }),
        'tab-1:leaf-b': liveEntry({
          paneKey: 'tab-1:leaf-b',
          agentType: 'codex',
          updatedAt: 50,
          providerSession: { key: 'session_id', id: 'new' }
        }),
        'tab-2:leaf-a': liveEntry({
          paneKey: 'tab-2:leaf-a',
          updatedAt: 99,
          providerSession: { key: 'session_id', id: 'other-tab' }
        })
      },
      sleepingAgentSessionsByPaneKey: {}
    })

    expect(result).toEqual({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'new' }
    })
  })

  it('falls back to a sleeping record when no live status remains', () => {
    const sleeping: SleepingAgentSessionRecord = {
      paneKey: 'tab-9:leaf',
      tabId: 'tab-9',
      worktreeId: 'wt',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sleep-sess' },
      prompt: 'hi',
      state: 'idle',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: { agentArgs: '--foo', agentEnv: {} }
    }

    expect(
      extractClosedTerminalAgentResume({
        tabId: 'tab-9',
        agentStatusByPaneKey: {},
        sleepingAgentSessionsByPaneKey: { 'tab-9:leaf': sleeping }
      })
    ).toEqual({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sleep-sess' },
      launchConfig: { agentArgs: '--foo', agentEnv: {} }
    })
  })

  it('returns null when the tab has no resumable provider session', () => {
    expect(
      extractClosedTerminalAgentResume({
        tabId: 'tab-1',
        agentStatusByPaneKey: {
          'tab-1:leaf': liveEntry({
            paneKey: 'tab-1:leaf',
            agentType: 'claude',
            providerSession: undefined
          })
        },
        sleepingAgentSessionsByPaneKey: {}
      })
    ).toBeNull()
  })
})
