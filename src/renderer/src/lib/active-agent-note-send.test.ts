import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveTerminalNoteTarget,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'

const testState = vi.hoisted(() => ({
  appState: {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': { activeLeafId: 'leaf-1' }
    },
    settings: {}
  } as {
    activeWorktreeId: string | null
    activeTabType: 'terminal' | 'editor'
    activeTabId: string | null
    activeTabIdByWorktree: Record<string, string | null>
    tabsByWorktree: Record<string, { id: string }[]>
    terminalLayoutsByTabId: Record<string, { activeLeafId: string | null }>
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
      terminalLayoutsByTabId: {
        'tab-1': { activeLeafId: 'leaf-1' }
      },
      settings: {}
    }
    testState.callRuntimeRpc.mockReset()
    testState.getActiveRuntimeTarget.mockClear()
    testState.getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
  })

  it('resolves the current worktree terminal pane from renderer state', () => {
    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('uses the per-worktree active tab fallback', () => {
    testState.appState.activeTabId = null
    testState.appState.activeTabIdByWorktree = { 'wt-1': 'tab-1' }

    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('uses the last active terminal tab while the user is viewing editor notes', () => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = { 'wt-1': 'tab-1' }

    expect(getActiveTerminalNoteTarget(testState.appState, 'wt-1')).toEqual({
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
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
              leafId: 'leaf-1',
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
      { terminal: 'term-1', text: 'File: src/app.ts', enter: true },
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
              leafId: 'leaf-1',
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
              leafId: 'leaf-1',
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
})
