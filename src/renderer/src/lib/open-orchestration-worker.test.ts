import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  focus: vi.fn(),
  remoteFocus: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
  reveal: vi.fn(),
  openLog: vi.fn(),
  state: {
    agentStatusByPaneKey: new Map(),
    retainedAgentsByPaneKey: {},
    activeWorktreeId: 'wt-bot',
    activeWorkspaceExecutionHostId: 'local' as const,
    unifiedTabsByWorktree: {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast, info: mocks.info } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      activateTab: vi.fn(),
      focusGroup: vi.fn(),
      setActiveTabType: vi.fn()
    })
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/terminal-pane/links/handles/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focus,
  focusRuntimeTerminalHandle: mocks.remoteFocus
}))
vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.reveal,
  activateAndRevealWorkspace: mocks.reveal
}))
vi.mock('@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open', () => ({
  openAiVaultSessionLogInOrca: mocks.openLog
}))
import { openOrchestrationWorker } from './open-orchestration-worker'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.focus.mockReturnValue(true)
})

it('reopens a terminal worker whose pane Orca released instead of reporting it gone', async () => {
  mocks.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_reopened' } })
  openOrchestrationWorker(
    {
      dispatchId: 'ctx_worker',
      title: 'Fix the flaky test',
      worktreeId: 'wt-bot',
      chatSessionId: null
    },
    { kind: 'local' }
  )
  await vi.waitFor(() => expect(mocks.focus).toHaveBeenCalledWith('term_reopened', null))
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'local' },
    'orchestration.partyOpen',
    { address: 'dispatch:ctx_worker' },
    { timeoutMs: 5000 }
  )
  expect(mocks.info).not.toHaveBeenCalled()
  expect(mocks.toast).not.toHaveBeenCalled()
})

const FINISHED = {
  dispatchId: 'ctx_done',
  title: 'PR 38365: still needed?',
  // Removed after the worker finished, so its terminal cannot come back.
  worktreeId: 'repo::/gone/pr-38365-e2e',
  chatSessionId: null
}
const TRANSCRIPT = '/home/me/.claude/projects/pr-38365-e2e/conversation.jsonl'

/** The host proves the worker's terminal gone; `transcript` answers the log read. */
function terminalGone(transcript: () => Promise<unknown>): void {
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'orchestration.partyOpen') {
      return { location: null, lost: 'terminal' }
    }
    if (method === 'orchestration.workerTranscript') {
      return transcript()
    }
    throw new Error(`unexpected ${method}`)
  })
}

it('opens the conversation log of a finished worker whose terminal is gone for good', async () => {
  terminalGone(async () => ({ transcript: { agent: 'claude', path: TRANSCRIPT } }))
  openOrchestrationWorker(FINISHED, { kind: 'local' })
  await vi.waitFor(() =>
    expect(mocks.openLog).toHaveBeenCalledExactlyOnceWith({
      agent: 'claude',
      filePath: TRANSCRIPT,
      executionHostId: 'local'
    })
  )
  expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerTranscript', {
    dispatch: 'ctx_done'
  })
  expect(mocks.info).not.toHaveBeenCalled()
  expect(mocks.toast).not.toHaveBeenCalled()
})

it('keeps the dead-pane notice when the worker left no log', async () => {
  terminalGone(async () => ({ transcript: null }))
  openOrchestrationWorker(FINISHED, { kind: 'local' })
  await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledOnce())
  expect(mocks.openLog).not.toHaveBeenCalled()
})

it('keeps the dead-pane notice on a host too old to read the log', async () => {
  terminalGone(async () => {
    throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
  })
  openOrchestrationWorker(FINISHED, { kind: 'local' })
  await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledOnce())
  expect(mocks.openLog).not.toHaveBeenCalled()
})

it("never opens a paired host's path on this computer", async () => {
  terminalGone(async () => ({ transcript: { agent: 'claude', path: TRANSCRIPT } }))
  openOrchestrationWorker(FINISHED, { kind: 'environment', environmentId: 'env-mini' })
  await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledOnce())
  expect(mocks.rpc).not.toHaveBeenCalledWith(
    expect.anything(),
    'orchestration.workerTranscript',
    expect.anything()
  )
  expect(mocks.openLog).not.toHaveBeenCalled()
})
