import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
type TestStore = ReturnType<typeof createTestStore>

function createOpenCodePaneStore(
  foreground: AppState['paneForegroundAgentByPaneKey'][string]
): TestStore {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: {
      'worktree-1': [
        makeTab({
          id: 'tab-1',
          worktreeId: 'worktree-1',
          title: 'OC | Continue weighted SLO scheduling work',
          launchAgent: 'opencode'
        })
      ]
    },
    paneForegroundAgentByPaneKey: { [PANE_KEY]: foreground }
  } as Partial<AppState>)
  return store
}

function sendInheritedClaudeStatus(
  store: TestStore,
  connectionId?: string | null,
  state: 'working' | 'done' = 'working',
  terminalTitle?: string
): void {
  store.getState().setAgentStatus(
    PANE_KEY,
    {
      state,
      prompt: 'Continue weighted SLO scheduling work',
      agentType: 'claude',
      model: 'claude-sonnet',
      restoredUnconfirmed: true
    },
    terminalTitle,
    undefined,
    connectionId === undefined
      ? undefined
      : { tabId: 'tab-1', worktreeId: 'worktree-1', connectionId },
    {
      providerSession: {
        key: 'session_id',
        id: 'inherited-claude-session',
        transcriptPath: '/tmp/inherited-claude-session.jsonl'
      }
    }
  )
}

describe('agent status foreground identity', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps OpenCode identity when its process and native title contradict a Claude hook', () => {
    vi.useFakeTimers()
    const store = createOpenCodePaneStore({
      agent: 'opencode',
      routingTrusted: true,
      shellForeground: false
    })
    sendInheritedClaudeStatus(store)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      agentType: 'opencode',
      terminalTitle: 'OC | Continue weighted SLO scheduling work'
    })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY].model).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[PANE_KEY].providerSession).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[PANE_KEY].restoredUnconfirmed).toBeUndefined()
  })

  it('uses the addressed pane title instead of the focused sibling title', () => {
    vi.useFakeTimers()
    const store = createOpenCodePaneStore({
      agent: 'opencode',
      routingTrusted: true,
      shellForeground: false
    })
    store.setState({
      tabsByWorktree: {
        'worktree-1': [
          makeTab({
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'zsh',
            launchAgent: 'opencode'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
          },
          activeLeafId: SIBLING_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: {
            '11111111-1111-4111-8111-111111111111': 'OC | Continue weighted SLO scheduling work',
            [SIBLING_LEAF_ID]: 'zsh'
          }
        }
      }
    } as Partial<AppState>)

    sendInheritedClaudeStatus(
      store,
      undefined,
      'working',
      'OC | Continue weighted SLO scheduling work'
    )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      agentType: 'opencode',
      terminalTitle: 'OC | Continue weighted SLO scheduling work'
    })
  })

  it('suppresses a first inherited child completion instead of completing OpenCode', () => {
    vi.useFakeTimers()
    const store = createOpenCodePaneStore({
      agent: 'opencode',
      routingTrusted: true,
      shellForeground: false
    })

    sendInheritedClaudeStatus(store, undefined, 'done')

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('keeps the hook identity for a remote-runtime pane', () => {
    vi.useFakeTimers()
    const store = createOpenCodePaneStore({
      agent: 'opencode',
      routingTrusted: true,
      shellForeground: false
    })
    const ptyId = 'remote:runtime-environment@@terminal-handle'
    store.setState({
      ptyIdsByTabId: { 'tab-1': [ptyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: ptyId }
        }
      }
    } as Partial<AppState>)

    sendInheritedClaudeStatus(store, null)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      agentType: 'claude',
      model: 'claude-sonnet',
      restoredUnconfirmed: true
    })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY].providerSession).toMatchObject({
      id: 'inherited-claude-session'
    })
  })

  it.each([
    ['launch-only hint', { agent: 'opencode', shellForeground: false }, undefined],
    [
      'shell foreground',
      { agent: 'opencode', routingTrusted: true, shellForeground: true },
      undefined
    ],
    [
      'remote route',
      { agent: 'opencode', routingTrusted: true, shellForeground: false },
      'ssh-connection-1'
    ],
    [
      'mismatched process',
      { agent: 'codex', routingTrusted: true, shellForeground: false },
      undefined
    ]
  ] as const)('keeps the hook identity for a %s', (_label, foreground, connectionId) => {
    vi.useFakeTimers()
    const store = createOpenCodePaneStore(foreground)
    sendInheritedClaudeStatus(store, connectionId)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      agentType: 'claude',
      model: 'claude-sonnet',
      restoredUnconfirmed: true
    })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY].providerSession).toMatchObject({
      id: 'inherited-claude-session'
    })
  })
})
