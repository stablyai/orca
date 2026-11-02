import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import {
  createNoteSendAppState,
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

describe('notes sent through a capable host', () => {
  beforeEach(() => {
    testState.appState = createNoteSendAppState()
    testState.callRuntimeRpc.mockReset()
    testState.sendGenerated.mockReset()
    testState.sendGenerated.mockResolvedValue(null)
  })

  // The host that owns the terminal admits and writes the notes; its outcome is the result, and
  // the guarded paste and Enter never run beside it.
  it.each([
    ['delivered', { status: 'sent' }],
    ['not-sent', { status: 'not-ready', code: 'terminal_wait_blocked' }],
    ['unconfirmed', { status: 'partial-submit-failed', code: 'submit-readiness-lost' }]
  ] as const)('reports a capable host answering %s as its own result', async (outcome, result) => {
    testState.appState.activeTabType = 'editor'
    testState.appState.activeTabIdByWorktree = {}
    testState.sendGenerated.mockResolvedValue(outcome)
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
        return { agentStatus: { handle: 'term-2', isRunningAgent: true, status: 'idle' } }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      })
    ).resolves.toEqual(result)
    expect(testState.sendGenerated).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'term-2',
      expect.objectContaining({ text: 'notes', submit: true, intent: 'running' })
    )
    expect(methods).not.toContain('terminal.send')
  })
})
