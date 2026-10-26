import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import {
  createNoteSendAppState,
  OTHER_LEAF_ID,
  PASTE_BEGIN,
  PASTE_END,
  type NoteSendAppState
} from './active-agent-note-send-test-harness'

let appState: NoteSendAppState

const testState = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
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
    (selector: (state: NoteSendAppState) => unknown) => selector(appState),
    {
      getState: () => appState
    }
  )
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => {
    if (args[1] === 'terminal.submitPrompt') {
      throw new testState.RuntimeRpcCallError({
        error: { code: 'method_not_found', message: 'Older host' }
      })
    }
    return testState.callRuntimeRpc(...args)
  }
}))
vi.mock('@/runtime/runtime-rpc-result', () => ({
  RuntimeRpcCallError: testState.RuntimeRpcCallError
}))

describe('active agent note send submit delay', () => {
  afterEach(() => vi.useRealTimers())

  beforeEach(() => {
    appState = createNoteSendAppState()
    testState.callRuntimeRpc.mockReset()
  })

  it.each([
    { host: 'current', submitDelayMs: 20_000, expectedDelayMs: 20_000 },
    { host: 'older', submitDelayMs: undefined, expectedDelayMs: 50 }
  ])(
    'waits after paste acknowledgment before submitting notes to a $host host',
    async ({ submitDelayMs, expectedDelayMs }) => {
      vi.useFakeTimers()
      appState.activeTabType = 'editor'
      appState.activeTabIdByWorktree = {}
      const methods: string[] = []
      const pasteAccepted = Promise.withResolvers<void>()
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
          if (params.text) {
            await pasteAccepted.promise
          }
          return {
            send: {
              handle: 'term-2',
              accepted: true,
              bytesWritten: typeof params.text === 'string' ? params.text.length : 1,
              ...(params.text && submitDelayMs !== undefined ? { submitDelayMs } : {})
            }
          }
        }
        throw new Error(`unexpected method ${method}`)
      })

      let delivered = false
      const send = sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'notes',
        noteTarget: { tabId: 'tab-9', leafId: OTHER_LEAF_ID }
      }).then((result) => {
        delivered = true
        return result
      })
      await vi.advanceTimersByTimeAsync(2000)
      expect(methods).toEqual(['terminal.list', 'terminal.agentStatus', 'terminal.send'])
      expect(delivered).toBe(false)
      pasteAccepted.resolve()
      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1)
      expect(methods).toEqual(['terminal.list', 'terminal.agentStatus', 'terminal.send'])
      expect(delivered).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(send).resolves.toEqual({ status: 'sent' })

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
    }
  )
})
