/* eslint-disable max-lines -- Why: these note-send routing cases share one mocked app store and RPC harness. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveAgentNoteTarget,
  getActiveAgentRuntimeProbeDescriptor,
  getActiveTerminalNoteTarget,
  probeActiveAgentNoteTarget,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../shared/types'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const NOW = 1_700_000_000_000

const testState = vi.hoisted(() => ({
  appState: {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['pty-1']
    },
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty-1' }
      }
    },
    agentStatusByPaneKey: {},
    settings: {}
  } as {
    activeWorktreeId: string | null
    activeTabType: 'terminal' | 'editor'
    activeTabId: string | null
    activeTabIdByWorktree: Record<string, string | null>
    tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]>
    ptyIdsByTabId: Record<string, string[]>
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>
    terminalLayoutsByTabId: Record<
      string,
      {
        activeLeafId: string | null
        root?: TerminalLayoutSnapshot['root']
        ptyIdsByLeafId?: Record<string, string | undefined>
      }
    >
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    settings: Record<string, unknown>
  },
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof testState.appState) => unknown) => selector(testState.appState),
    {
      getState: () => testState.appState
    }
  )
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: testState.callRuntimeRpc,
  getActiveRuntimeTarget: testState.getActiveRuntimeTarget
}))

describe('active agent note send', () => {
  beforeEach(() => {
    testState.appState = {
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'tab-1',
      activeTabIdByWorktree: {},
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {
        'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } }
      },
      agentStatusByPaneKey: {},
      settings: {}
    }
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

  it('sends notes only after the active terminal is verified as an idle agent', async () => {
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
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
              title: 'Codex',
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
      if (method === 'terminal.wait') {
        return {
          wait: {
            handle: 'term-1',
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          }
        }
      }
      if (method === 'terminal.send') {
        return { send: { handle: 'term-1', accepted: true, bytesWritten: params.text.length } }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'File: src/app.ts' })
    ).resolves.toEqual({ status: 'sent' })

    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.list',
      { worktree: 'id:wt-1', limit: 200 },
      { timeoutMs: 15000 }
    )
    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-1',
        text: 'File: src/app.ts',
        enter: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
  })

  it('does not write notes when the active terminal is not an agent', async () => {
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
              title: 'zsh',
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
        return { isRunningAgent: false }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'no-agent' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('does not write notes when the active agent is not ready', async () => {
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
              title: 'Codex',
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
      if (method === 'terminal.wait') {
        throw new Error('timeout')
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'not-ready' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('does not call runtime when no terminal pane is known for the worktree', async () => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = {}

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'no-active-terminal' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends notes to an explicit note target even when no terminal pane is focused', async () => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = {}
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      if (method === 'terminal.list') {
        return {
          terminals: [
            {
              handle: 'term-2',
              worktreeId: 'wt-1',
              worktreePath: '/repo',
              branch: 'main',
              tabId: 'tab-9',
              leafId: OTHER_LEAF_ID,
              title: 'Codex',
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
      if (method === 'terminal.wait') {
        return {
          wait: {
            handle: 'term-2',
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          }
        }
      }
      if (method === 'terminal.send') {
        return { send: { handle: 'term-2', accepted: true, bytesWritten: params.text.length } }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'sent' })

    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-2',
        text: 'notes',
        enter: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
  })

  it('returns no-active-terminal when the explicit note target is absent from the runtime list', async () => {
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
              title: 'Codex',
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
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-1', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'no-active-terminal' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
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
