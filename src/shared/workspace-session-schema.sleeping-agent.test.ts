import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession sleeping agents', () => {
  it('preserves valid sleeping agent resume records', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          terminalTitle: 'Codex',
          lastAssistantMessage: 'done',
          launchConfig: {
            agentArgs: '',
            agentEnv: {}
          },
          origin: 'live'
        }
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.agent).toBe('codex')
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.origin).toBe('live')
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.launchConfig).toEqual({
        agentArgs: '',
        agentEnv: {}
      })
    }
  })

  it('preserves the authoritative Pi session file through hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'pi',
          providerSession: {
            key: 'session_id',
            id: 'pi-session',
            transcriptPath: '/tmp/pi-session.jsonl'
          },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.providerSession).toEqual(
        {
          key: 'session_id',
          id: 'pi-session',
          transcriptPath: '/tmp/pi-session.jsonl'
        }
      )
    }
  })

  it('preserves the AI Vault OMP resume file through hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'omp',
          providerSession: { key: 'session_id', id: 'omp-session' },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          launchConfig: {
            agentArgs: '',
            agentEnv: {},
            ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
          },
          origin: 'quit'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(
        result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.launchConfig
          ?.ompResumeFilePath
      ).toBe('/custom/omp-sessions/project/session.jsonl')
    }
  })

  it('drops Pi sleeping-agent records without an authoritative session file', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session' },
          prompt: '',
          state: 'done',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey).toBeUndefined()
    }
  })

  it('drops invalid sleeping agent launch config without dropping the record', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          launchConfig: {
            agentArgs: '--model high',
            agentEnv: { 'BAD=KEY': 'value' }
          }
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const record = result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
    }
  })

  it('drops launch config with prototype-polluting env keys without dropping siblings', () => {
    const sessions = JSON.parse(`{
      "__proto__": {
        "paneKey": "__proto__",
        "worktreeId": "wt",
        "agent": "codex",
        "providerSession": { "key": "session_id", "id": "bad-session" },
        "prompt": "bad",
        "state": "working",
        "capturedAt": 10,
        "updatedAt": 9
      },
      "tab1:pane-1": {
        "paneKey": "tab1:pane-1",
        "tabId": "tab1",
        "worktreeId": "wt",
        "agent": "codex",
        "providerSession": { "key": "session_id", "id": "codex-session" },
        "prompt": "continue",
        "state": "working",
        "capturedAt": 10,
        "updatedAt": 9,
        "launchConfig": {
          "agentArgs": "",
          "agentEnv": { "__proto__": "polluted" }
        }
      }
    }`)
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: sessions
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(
        Object.prototype.hasOwnProperty.call(
          result.value.sleepingAgentSessionsByPaneKey ?? {},
          '__proto__'
        )
      ).toBe(false)
      const record = result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  })

  it('preserves sleeping agent launch env values with whitespace characters', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          launchConfig: {
            agentArgs: '',
            agentEnv: { MULTILINE: 'line1\nline2\tok' }
          }
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(
        result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.launchConfig?.agentEnv
      ).toEqual({ MULTILINE: 'line1\nline2\tok' })
    }
  })

  it('drops sleeping agent launch config with NUL env values without dropping the record', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          launchConfig: {
            agentArgs: '',
            agentEnv: { BAD_VALUE: 'ok\0bad' }
          }
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const record = result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
    }
  })

  it('preserves sleeping agent record origin across hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'devin',
          providerSession: { key: 'session_id', id: 'devin-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          origin: 'quit'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.origin).toBe('quit')
    }
  })

  it('preserves interrupted sleeping agent records across hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'done',
          capturedAt: 10,
          updatedAt: 9,
          interrupted: true,
          origin: 'worktree-sleep'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.interrupted).toBe(true)
    }
  })

  it('preserves legacy live sleeping agent origins across hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          origin: 'live'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.origin).toBe('live')
    }
  })

  it('drops malformed sleeping agent resume records without failing the whole session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          worktreeId: 'wt',
          agent: 'definitely-not-an-agent',
          providerSession: { key: 'session_id', id: 'bogus-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        }
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey).toBeUndefined()
    }
  })

  it('preserves valid sleeping agent resume records when sibling records are malformed', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        },
        'tab2:pane-1': {
          paneKey: 'tab2:pane-1',
          worktreeId: 'wt',
          agent: 'not-real',
          providerSession: { key: 'session_id', id: 'bad-session' },
          prompt: 'ignore me',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        }
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.agent).toBe('codex')
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab2:pane-1']).toBeUndefined()
    }
  })

  it('drops sleeping agent records with unsafe provider session ids without dropping valid siblings', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        },
        'tab2:pane-1': {
          paneKey: 'tab2:pane-1',
          tabId: 'tab2',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: '--last' },
          prompt: 'ignore me',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        }
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.providerSession.id).toBe(
        'codex-session'
      )
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab2:pane-1']).toBeUndefined()
    }
  })

  it('drops sleeping agent records whose embedded pane key differs from the map key', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        },
        'tab2:pane-1': {
          paneKey: 'other-tab:pane-1',
          tabId: 'tab2',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'mismatched-session' },
          prompt: 'ignore me',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9
        }
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.providerSession.id).toBe(
        'codex-session'
      )
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab2:pane-1']).toBeUndefined()
    }
  })
})
