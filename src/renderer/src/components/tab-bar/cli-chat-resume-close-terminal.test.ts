// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  state: {
    tabsByWorktree: { workspace: [{ id: 'tab', createdAt: 1 }] },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' }
        },
        ptyIdsByLeafId: { a: 'pty-a', b: 'pty-b' }
      }
    },
    ptyIdsByTabId: { tab: ['pty-a', 'pty-b'] },
    terminalPtyIncarnationsByPaneKey: { 'tab:a': 'inc-a', 'tab:b': 'inc-b' }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: (host: string) =>
    host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'paired' }
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.close }))
import { closeCliChatResumeTerminal } from './cli-chat-resume-close-terminal'
const source = {
  tabId: 'tab',
  workspaceId: 'workspace',
  paneKey: 'tab:a',
  agent: 'claude',
  providerSessionId: 'conversation',
  executionHostId: 'local'
} as const
const hooks = (closing = vi.fn()) => ({ prepared: vi.fn(), closing, refused: vi.fn() })
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.terminalPtyIncarnationsByPaneKey['tab:a'] = 'inc-a'
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'terminal.resolvePane') {
      const leaf = params.paneKey.endsWith(':b') ? 'b' : 'a'
      return {
        terminal: { handle: `handle-${leaf}`, ptyId: `pty-${leaf}`, incarnationId: `inc-${leaf}` }
      }
    }
    return { wait: { satisfied: true, status: 'exited', exitCode: 0 } }
  })
  mocks.close.mockImplementation((_tab, options) => {
    options.beforeClose()
  })
})
it.each<ExecutionHostId>(['local', 'runtime:paired'])(
  'pins every split PTY before ordinary tab close on %s and waits for all exits',
  async (executionHostId) => {
    const exit = deferred<{
      wait: Pick<RuntimeTerminalWait, 'satisfied' | 'status' | 'exitCode'>
    }>()
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'terminal.resolvePane') {
        const leaf = params.paneKey.endsWith(':b') ? 'b' : 'a'
        return {
          terminal: { handle: `handle-${leaf}`, ptyId: `pty-${leaf}`, incarnationId: `inc-${leaf}` }
        }
      }
      return params.terminal === 'handle-b'
        ? exit.promise
        : { wait: { satisfied: true, status: 'exited', exitCode: 0 } }
    })
    const closing = vi.fn(() =>
      expect(mocks.call.mock.calls.filter((call) => call[1] === 'terminal.wait')).toHaveLength(2)
    )
    let finished = false
    const closeHooks = hooks(closing)
    const run = closeCliChatResumeTerminal(
      { ...source, executionHostId },
      () => true,
      closeHooks,
      new AbortController().signal
    ).then((value) => {
      finished = true
      return value
    })
    await vi.waitFor(() => expect(closing).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    expect(closeHooks.prepared).toHaveBeenCalledOnce()
    // Only the split's other pane can ask about running work, and the chat keeps the worktree open.
    expect(mocks.close).toHaveBeenCalledWith(
      'tab',
      expect.objectContaining({
        consentedPtyId: 'pty-a',
        preserveWorktreeSelection: true,
        onCancel: expect.any(Function)
      })
    )
    exit.resolve({ wait: { satisfied: true, status: 'exited', exitCode: 0 } })
    await expect(run).resolves.toBe(true)
  }
)
it('leaves the tab and opens nothing when the ordinary close confirmation is cancelled', async () => {
  mocks.close.mockImplementation((_tab, options) => options.onCancel())
  const closing = vi.fn()
  await expect(
    closeCliChatResumeTerminal(source, () => true, hooks(closing), new AbortController().signal)
  ).resolves.toBe(false)
  expect(closing).not.toHaveBeenCalled()
  expect(mocks.call.mock.calls.filter((call) => call[1] === 'terminal.wait')).toHaveLength(0)
})
it.each([
  {
    satisfied: true,
    status: 'exited',
    exitCode: -1,
    exitCause: { kind: 'unknown', reason: 'stop_unverified' }
  },
  { satisfied: true, status: 'unknown', exitCode: null }
])('rejects unproven exit evidence: %j', async (wait) => {
  mocks.call.mockImplementation(async (_target, method, params) => {
    const leaf = params.paneKey?.endsWith(':b') ? 'b' : 'a'
    return method === 'terminal.resolvePane'
      ? {
          terminal: { handle: `handle-${leaf}`, ptyId: `pty-${leaf}`, incarnationId: `inc-${leaf}` }
        }
      : { wait }
  })
  await expect(
    closeCliChatResumeTerminal(source, () => true, hooks(), new AbortController().signal)
  ).rejects.toThrow('terminal exit unproven')
})
it('rechecks the source incarnation after an existing close dialog and says the close was dropped', async () => {
  mocks.close.mockImplementation((_tab, options) => {
    mocks.state.terminalPtyIncarnationsByPaneKey['tab:a'] = 'replacement'
    expect(options.beforeClose()).toBe(false)
    options.onCancel()
  })
  const closeHooks = hooks()
  await expect(
    closeCliChatResumeTerminal(source, () => true, closeHooks, new AbortController().signal)
  ).resolves.toBe(false)
  expect(closeHooks.refused).toHaveBeenCalledOnce()
  expect(closeHooks.closing).not.toHaveBeenCalled()
  expect(mocks.call.mock.calls.filter((call) => call[1] === 'terminal.wait')).toHaveLength(0)
})
it('reports a vetoed confirmed close to its run even after the run was retired', async () => {
  const controller = new AbortController()
  let reenter: (() => boolean) | undefined
  mocks.close.mockImplementation((_tab, options) => {
    reenter = options.beforeClose
  })
  const closeHooks = hooks()
  const run = closeCliChatResumeTerminal(source, () => true, closeHooks, controller.signal)
  await vi.waitFor(() => expect(reenter).toBeDefined())
  controller.abort()
  await expect(run).resolves.toBe(false)
  expect(reenter?.()).toBe(false)
  // The run, not this helper, knows whether a newer continuation owns the confirmation.
  expect(closeHooks.refused).toHaveBeenCalledOnce()
  expect(closeHooks.closing).not.toHaveBeenCalled()
})
