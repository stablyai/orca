import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveAgentNoteTarget,
  getActiveAgentRuntimeProbeDescriptor,
  getActiveTerminalNoteTarget,
  probeActiveAgentNoteTarget
} from './active-agent-note-send'
import {
  createNoteSendAppState,
  LEAF_ID,
  OTHER_LEAF_ID,
  type NoteSendAppState
} from './active-agent-note-send-test-harness'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'

const NOW = 1_700_000_000_000

const testState = vi.hoisted(() => ({
  appState: null as unknown as NoteSendAppState,
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' })),
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    readonly code: string
    readonly response: unknown

    constructor(response: { error: { code: string; message: string } }) {
      super(response.error.message)
      this.name = 'RuntimeRpcCallError'
      this.code = response.error.code
      this.response = response
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: NoteSendAppState) => unknown) => selector(testState.appState),
    {
      getState: () => testState.appState
    }
  )
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: testState.callRuntimeRpc,
  getActiveRuntimeTarget: testState.getActiveRuntimeTarget,
  RuntimeRpcCallError: testState.RuntimeRpcCallError
}))

describe('active agent note send', () => {
  beforeEach(() => {
    testState.appState = createNoteSendAppState()
    testState.callRuntimeRpc.mockReset()
    testState.getActiveRuntimeTarget.mockClear()
    testState.getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
  })

  it('resolves the current worktree terminal pane from renderer state', () => {
    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('uses the per-worktree active tab fallback', () => {
    testState.appState.activeTabId = null
    testState.appState.activeTabIdByWorktree = { 'wt-1': 'tab-1' }

    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('uses the last active terminal tab while the user is viewing editor notes', () => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = { 'wt-1': 'tab-1' }

    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('does not offer the active terminal send target when the focused pane has no agent status', () => {
    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })

  it('runtime-probes a manually started agent before title or hooks report it', async () => {
    testState.callRuntimeRpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.list') {
        return {
          terminals: [
            {
              handle: 'term-1',
              worktreeId: 'wt-1',
              worktreePath: '/repo',
              branch: 'main',
              tabId: 'tab-1',
              leafId: LEAF_ID,
              title: 'repo terminal',
              connected: true,
              writable: true,
              lastOutputAt: 1,
              preview: ''
            }
          ],
          totalCount: 1,
          truncated: false
        }
      }
      if (method === 'terminal.isRunningAgent') {
        return { isRunningAgent: true }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const descriptor = getActiveAgentRuntimeProbeDescriptor(testState.appState, 'wt-1')

    expect(descriptor).toMatchObject({
      key: `local:wt-1:tab-1:${LEAF_ID}:pty-1`,
      noteTarget: { tabId: 'tab-1', leafId: LEAF_ID }
    })
    await expect(probeActiveAgentNoteTarget(descriptor!)).resolves.toBe(true)
  })

  it('offers the active terminal send target for a fresh title-detected agent before hooks report', () => {
    testState.appState.runtimePaneTitlesByTabId = {
      'tab-1': { 1: 'Codex' }
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('offers the active terminal send target for an Orca-launched agent before hooks report', () => {
    testState.appState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }]
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('does not let an old launch marker override a focused shell title', () => {
    testState.appState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }]
    }
    testState.appState.runtimePaneTitlesByTabId = {
      'tab-1': { 1: 'zsh' }
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })

  it('does not offer the active terminal send target for another split pane title', () => {
    testState.appState.runtimePaneTitlesByTabId = {
      'tab-1': { 1: 'zsh', 2: 'Codex' }
    }
    testState.appState.terminalLayoutsByTabId = {
      'tab-1': {
        activeLeafId: LEAF_ID,
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: OTHER_LEAF_ID }
        },
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })

  it('does not treat a lone background split-pane title as the focused pane', () => {
    testState.appState.runtimePaneTitlesByTabId = {
      'tab-1': { 2: 'Codex' }
    }
    testState.appState.terminalLayoutsByTabId = {
      'tab-1': {
        activeLeafId: LEAF_ID,
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: OTHER_LEAF_ID }
        },
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })

  it('offers the active terminal send target when the focused pane is a fresh agent session', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    testState.appState.agentStatusByPaneKey = {
      [paneKey]: agentStatusEntry(paneKey, { updatedAt: NOW })
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('does not offer the active terminal send target for stale or unfocused agent status', () => {
    const focusedPaneKey = makePaneKey('tab-1', LEAF_ID)
    const otherPaneKey = makePaneKey('tab-1', OTHER_LEAF_ID)
    testState.appState.agentStatusByPaneKey = {
      [focusedPaneKey]: agentStatusEntry(focusedPaneKey, { updatedAt: NOW - 31 * 60 * 1000 }),
      [otherPaneKey]: agentStatusEntry(otherPaneKey, { updatedAt: NOW })
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })

  it('does not offer the active terminal send target when the focused pane pty is not live', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    testState.appState.ptyIdsByTabId = { 'tab-1': [] }
    testState.appState.terminalLayoutsByTabId = {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } }
    }
    testState.appState.agentStatusByPaneKey = {
      [paneKey]: agentStatusEntry(paneKey, { updatedAt: NOW })
    }

    expect(getActiveAgentNoteTarget(testState.appState, 'wt-1', NOW)).toBeNull()
  })
})

function agentStatusEntry(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const updatedAt = overrides.updatedAt ?? NOW
  return {
    state: 'done',
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt,
    agentType: 'codex',
    paneKey,
    stateHistory: [],
    ...overrides
  }
}
