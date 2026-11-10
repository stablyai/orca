import { resumablePaneRecord } from '../agent-session/lifecycle/agent-session-resume'
import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession sleeping agents', () => {
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
      expect(Object.hasOwn(result.value.sleepingAgentSessionsByPaneKey ?? {}, '__proto__')).toBe(
        false
      )
      const record = resumablePaneRecord(
        result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      )
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  })
})

it('loads mixed sleep formats without treating display-only panes as resume recipes', () => {
  const display = {
    kind: 'display-only',
    paneKey: 'tab1:pane-1',
    tabId: 'tab1',
    worktreeId: 'wt',
    origin: 'worktree-sleep',
    capturedAt: 30,
    display: {
      state: 'done',
      agentType: 'custom-cli',
      prompt: 'finish',
      updatedAt: 20,
      stateStartedAt: 10,
      firstStateStartedAt: 5,
      interrupted: true
    }
  }
  const result = parseWorkspaceSession({
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    retainedAgentsByPaneKey: { obsolete: {} },
    sleepingAgentSessionsByPaneKey: {
      'tab1:pane-1': display,
      'tab2:pane-2': {
        paneKey: 'tab2:pane-2',
        worktreeId: 'wt',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'legacy-session' },
        prompt: '',
        state: 'working',
        capturedAt: 30,
        updatedAt: 20
      },
      'tab3:pane-3': { ...display, paneKey: 'tab3:pane-3', kind: 'future-kind' },
      'tab4:pane-4': {
        ...display,
        paneKey: 'tab4:pane-4',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    }
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('valid old and new sleep records must load')
  }
  expect(result.value.sleepingAgentSessionsByPaneKey).toEqual({
    'tab1:pane-1': display,
    'tab2:pane-2': {
      paneKey: 'tab2:pane-2',
      worktreeId: 'wt',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'legacy-session' },
      prompt: '',
      state: 'working',
      capturedAt: 30,
      updatedAt: 20
    }
  })
  expect(
    resumablePaneRecord(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1'])
  ).toBeUndefined()
})
