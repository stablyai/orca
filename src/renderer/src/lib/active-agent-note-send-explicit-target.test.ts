import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'
import {
  createNoteSendAppState,
  LEAF_ID,
  OTHER_LEAF_ID,
  type NoteSendAppState
} from './active-agent-note-send-test-harness'

const testState = vi.hoisted(() => ({
  appState: null as unknown as NoteSendAppState,
  callRuntimeRpc: vi.fn(),
  sendGenerated: vi.fn(),
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

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: testState.callRuntimeRpc }))
vi.mock('@/runtime/generated-terminal-input-client', () => ({
  sendGeneratedTerminalInputToHandle: testState.sendGenerated
}))
vi.mock('@/runtime/runtime-rpc-result', () => ({
  RuntimeRpcCallError: testState.RuntimeRpcCallError
}))

describe('active agent note send', () => {
  beforeEach(() => {
    testState.appState = createNoteSendAppState()
    testState.callRuntimeRpc.mockReset()
    testState.sendGenerated.mockReset()
    // The local runtime always runs the generated-input operation itself.
    testState.sendGenerated.mockResolvedValue('delivered')
  })

  it('sends notes immediately to an explicit note target through the generated-input operation', async () => {
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

    // The notes are generated input: the host's operation takes them, never a raw paste and Enter.
    expect(methods).toEqual(['terminal.list', 'terminal.agentStatus'])
    expect(testState.sendGenerated).toHaveBeenCalledWith(
      { kind: 'local' },
      'term-2',
      expect.objectContaining({ text: 'notes', submit: true, intent: 'running' })
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
        return { agentStatus: { handle: 'term-2', isRunningAgent: false, status: null } }
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

    // The notes are generated input: the host's operation takes them, never a raw paste and Enter.
    expect(methods).toEqual(['terminal.list', 'terminal.agentStatus'])
    expect(testState.sendGenerated).toHaveBeenCalledWith(
      { kind: 'local' },
      'term-2',
      expect.objectContaining({ text: 'notes', submit: true, intent: 'running' })
    )

    // The host's operation, not the snapshot, decides: a target with no agent reading input refuses.
    methods.length = 0
    testState.sendGenerated.mockResolvedValueOnce('not-sent')
    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual({ status: 'not-ready', code: 'terminal_wait_blocked' })
    expect(methods).toEqual(['terminal.list', 'terminal.agentStatus'])
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
