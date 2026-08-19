import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import {
  createNoteSendAppState,
  LEAF_ID,
  PASTE_BEGIN,
  PASTE_END,
  type NoteSendAppState
} from './active-agent-note-send-test-harness'

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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: true, status: 'idle' } }
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
        return {
          send: {
            handle: 'term-1',
            accepted: true,
            bytesWritten: typeof params.text === 'string' ? params.text.length : 1
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'File: src/app.ts' })
    ).resolves.toEqual({ status: 'sent' })

    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.list',
      { worktree: 'id:wt-1', limit: 200, includeVisualLayouts: false },
      { timeoutMs: 15000 }
    )
    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-1',
        text: `${PASTE_BEGIN}File: src/app.ts${PASTE_END}`,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
    expect(testState.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
  })

  it('maps active-focused guarded paste permission refusal to permission', async () => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: true, status: 'idle' } }
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
        expect(params).toMatchObject({
          terminal: 'term-1',
          requireAgentStatus: 'sendable'
        })
        return {
          send: {
            handle: 'term-1',
            accepted: false,
            bytesWritten: 0,
            refusedReason: 'permission'
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'permission' })
  })

  it('keeps active-focused sends compatible when an older runtime lacks agentStatus', async () => {
    const methods: string[] = []
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      methods.push(method)
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
      if (method === 'terminal.agentStatus') {
        throw new testState.RuntimeRpcCallError({
          error: { code: 'method_not_found', message: 'Unknown method: terminal.agentStatus' }
        })
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

    expect(methods).toEqual([
      'terminal.list',
      'terminal.agentStatus',
      'terminal.isRunningAgent',
      'terminal.wait',
      'terminal.agentStatus',
      'terminal.isRunningAgent',
      'terminal.send'
    ])
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: false, status: null } }
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: true, status: 'working' } }
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

  it('maps non-running active-focused waits to no active terminal', async () => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.wait') {
        return {
          wait: {
            handle: 'term-1',
            condition: 'tui-idle',
            satisfied: false,
            status: 'exited',
            exitCode: 0
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'no-active-terminal' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('maps active-focused blocked waits to permission without writing', async () => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-1', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.wait') {
        return {
          wait: {
            handle: 'term-1',
            condition: 'tui-idle',
            satisfied: false,
            status: 'running',
            exitCode: null,
            blockedReason: 'codex-interactive-prompt'
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'permission' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('rechecks active-focused permission after idle wait succeeds before writing', async () => {
    let statusChecks = 0
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
      if (method === 'terminal.agentStatus') {
        statusChecks += 1
        return {
          agentStatus: {
            handle: 'term-1',
            isRunningAgent: true,
            status: statusChecks === 1 ? 'idle' : 'permission'
          }
        }
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
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({ worktreeId: 'wt-1', prompt: 'notes' })
    ).resolves.toEqual({ status: 'permission' })

    expect(statusChecks).toBe(2)
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
