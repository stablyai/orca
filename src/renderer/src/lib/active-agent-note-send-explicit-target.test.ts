import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'
import {
  createNoteSendAppState,
  LEAF_ID,
  OTHER_LEAF_ID,
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

  it('sends notes immediately to an explicit note target using bracketed paste and Enter', async () => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = {}
    const methods: string[] = []
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      methods.push(method)
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.send') {
        return {
          send: {
            handle: 'term-2',
            accepted: true,
            bytesWritten: typeof params.text === 'string' ? params.text.length : 1
          }
        }
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

    expect(methods).toEqual([
      'terminal.list',
      'terminal.agentStatus',
      'terminal.send',
      'terminal.agentStatus',
      'terminal.send'
    ])
    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-2',
        text: `${PASTE_BEGIN}notes${PASTE_END}`,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
    expect(testState.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'terminal.send',
      {
        terminal: 'term-2',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 15000 }
    )
  })

  it('refuses explicit targets when an older runtime cannot verify agent status', async () => {
    const methods: string[] = []
    testState.callRuntimeRpc.mockImplementation(async (_target, method) => {
      methods.push(method)
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
      if (method === 'terminal.agentStatus') {
        throw new testState.RuntimeRpcCallError({
          error: { code: 'method_not_found', message: 'Unknown method: terminal.agentStatus' }
        })
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'status-unavailable', code: 'status-unavailable' })

    expect(methods).toEqual(['terminal.list', 'terminal.agentStatus'])
    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('sanitizes embedded escape bytes before wrapping explicit target notes', async () => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: null } }
      }
      if (method === 'terminal.send') {
        return {
          send: {
            handle: 'term-2',
            accepted: true,
            bytesWritten: typeof params.text === 'string' ? params.text.length : 1
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes \x1b[201~ tail',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'sent' })

    expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.send',
      expect.objectContaining({
        text: `${PASTE_BEGIN}notes \u241b[201~ tail${PASTE_END}`,
        requireAgentStatus: 'sendable'
      }),
      { timeoutMs: 15000 }
    )
  })

  it('refuses explicit targets that are permission-blocked before writing', async () => {
    testState.callRuntimeRpc.mockImplementation(async (_target, method) => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'permission' } }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'permission', code: 'agent-permission' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('lets guarded sends decide after transient no-agent snapshots for explicit targets', async () => {
    const methods: string[] = []
    let guardedSendAccepted = true
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      methods.push(method)
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: false, status: null } }
      }
      if (method === 'terminal.send') {
        expect(params).toMatchObject({
          terminal: 'term-2',
          requireAgentStatus: 'sendable'
        })
        return {
          send: {
            handle: 'term-2',
            accepted: guardedSendAccepted,
            bytesWritten: guardedSendAccepted
              ? typeof params.text === 'string'
                ? params.text.length
                : 1
              : 0,
            ...(guardedSendAccepted ? {} : { refusedReason: 'no-agent' })
          }
        }
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

    expect(methods).toEqual([
      'terminal.list',
      'terminal.agentStatus',
      'terminal.send',
      'terminal.agentStatus',
      'terminal.send'
    ])

    methods.length = 0
    guardedSendAccepted = false
    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'no-agent', code: 'no-agent' })
    expect(methods).toEqual(['terminal.list', 'terminal.agentStatus', 'terminal.send'])
  })

  it('maps explicit target first-write refusal to not-writable', async () => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.send') {
        return { send: { handle: 'term-2', accepted: false, bytesWritten: 0 } }
      }
      throw new Error(`unexpected method ${method} ${String(params)}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'not-writable', code: 'terminal-send-refused' })

    const sendCalls = testState.callRuntimeRpc.mock.calls.filter(
      (call) => call[1] === 'terminal.send'
    )
    expect(sendCalls).toHaveLength(1)
  })

  it('maps explicit target guarded paste permission refusal to permission', async () => {
    testState.callRuntimeRpc.mockImplementation(async (_target, method) => {
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.send') {
        return {
          send: {
            handle: 'term-2',
            accepted: false,
            bytesWritten: 0,
            refusedReason: 'permission'
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'permission', code: 'terminal-send-permission' })

    const sendCalls = testState.callRuntimeRpc.mock.calls.filter(
      (call) => call[1] === 'terminal.send'
    )
    expect(sendCalls).toHaveLength(1)
  })

  it('maps explicit target permission or unavailable state before Enter to partial-submit-failed', async () => {
    let statusChecks = 0
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
      if (method === 'terminal.agentStatus') {
        statusChecks += 1
        return {
          agentStatus: {
            handle: 'term-2',
            isRunningAgent: true,
            status: statusChecks === 1 ? 'working' : 'permission'
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
    ).resolves.toEqual({ status: 'partial-submit-failed', code: 'submit-readiness-lost' })

    const sendCalls = testState.callRuntimeRpc.mock.calls.filter(
      (call) => call[1] === 'terminal.send'
    )
    expect(sendCalls).toHaveLength(1)
  })

  it('maps explicit target Enter write failure to partial-submit-failed', async () => {
    let sendCount = 0
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'idle' } }
      }
      if (method === 'terminal.send') {
        sendCount += 1
        return {
          send: {
            handle: 'term-2',
            accepted: sendCount === 1,
            bytesWritten: typeof params.text === 'string' ? params.text.length : 0
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'partial-submit-failed', code: 'submit-send-refused' })
  })

  it('maps explicit target guarded Enter permission refusal to partial-submit-failed', async () => {
    let sendCount = 0
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'idle' } }
      }
      if (method === 'terminal.send') {
        sendCount += 1
        return sendCount === 1
          ? {
              send: {
                handle: 'term-2',
                accepted: true,
                bytesWritten: typeof params.text === 'string' ? params.text.length : 0
              }
            }
          : {
              send: {
                handle: 'term-2',
                accepted: false,
                bytesWritten: 0,
                refusedReason: 'permission'
              }
            }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'partial-submit-failed', code: 'submit-send-refused' })
  })

  it('uses selected-target failure wording for explicit note targets', () => {
    expect(activeAgentNotesSendFailureMessage('not-ready', { explicitTarget: true })).toBe(
      'The selected agent was not ready for input yet.'
    )
    expect(activeAgentNotesSendFailureMessage('not-ready')).toBe(
      'The active agent was not ready for input yet.'
    )
    expect(activeAgentNotesSendFailureMessage('permission', { explicitTarget: true })).toBe(
      'The selected agent needs permission.'
    )
    expect(activeAgentNotesSendFailureMessage('permission')).toBe(
      'The active agent needs permission.'
    )
    expect(activeAgentNotesSendFailureMessage('status-unavailable', { explicitTarget: true })).toBe(
      'The selected agent status could not be verified.'
    )
    expect(
      activeAgentNotesSendFailureMessage('partial-submit-failed', { explicitTarget: true })
    ).toBe(
      'The notes may already be pasted in the selected terminal, but Orca could not submit them.'
    )
    expect(activeAgentNotesSendFailureMessage('partial-submit-failed')).toBe(
      'The notes may already be pasted in the active terminal, but Orca could not submit them.'
    )
    expect(
      activeAgentNotesSendFailureMessage('no-active-terminal', {
        explicitTarget: true,
        code: 'no-inventory-match'
      })
    ).toBe('The selected terminal is no longer available. (no-inventory-match)')
  })

  it.each(['terminal_handle_stale', 'terminal_exited', 'terminal_gone'] as const)(
    'returns and logs the runtime terminal failure code %s without note contents',
    async (runtimeCode) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      testState.callRuntimeRpc.mockImplementation(async (_target, method) => {
        if (method === 'terminal.list') {
          return {
            terminals: [
              {
                handle: 'term-runtime-failure',
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
        if (method === 'terminal.agentStatus') {
          throw new Error(runtimeCode)
        }
        throw new Error(`unexpected method ${method}`)
      })

      await expect(
        sendNotesToActiveAgentSession({
          worktreeId: 'wt-1',
          prompt: 'private note contents',
          noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
        })
      ).resolves.toEqual({ status: 'no-active-terminal', code: runtimeCode })

      expect(warn).toHaveBeenCalledWith('[review-notes] send failed', {
        code: runtimeCode,
        status: 'no-active-terminal',
        tabId: 'tab-9',
        leafId: OTHER_LEAF_ID
      })
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private note contents')
      warn.mockRestore()
    }
  )

  it.each([
    ['remote connection closed at /private/workspace', 'runtime-unverifiable'],
    ['runtime request timeout', 'runtime-timeout']
  ] as const)(
    'classifies terminal inventory failure without logging raw error details: %s',
    async (message, code) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      testState.callRuntimeRpc.mockRejectedValue(new Error(message))

      await expect(
        sendNotesToActiveAgentSession({
          worktreeId: 'wt-1',
          prompt: 'private note contents',
          noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
        })
      ).resolves.toEqual({ status: 'status-unavailable', code })

      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain(code)
      expect(logged).not.toContain(message)
      expect(logged).not.toContain('private note contents')
      warn.mockRestore()
    }
  )

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
    ).resolves.toEqual({ status: 'no-active-terminal', code: 'no-inventory-match' })

    expect(testState.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'terminal.send',
      expect.anything(),
      expect.anything()
    )
  })

  it('matches mirrored renderer tab IDs to host runtime tab IDs', async () => {
    testState.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      if (method === 'terminal.list') {
        return {
          terminals: [
            {
              handle: 'term-mirrored',
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
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { handle: 'term-mirrored', isRunningAgent: true, status: 'working' } }
      }
      if (method === 'terminal.send') {
        return {
          send: {
            handle: 'term-mirrored',
            accepted: true,
            bytesWritten: typeof params.text === 'string' ? params.text.length : 1
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'web-terminal-tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'sent' })
  })
})
