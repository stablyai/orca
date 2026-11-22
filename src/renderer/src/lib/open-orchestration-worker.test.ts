import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { openAiVaultSessionLogInOrca } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  focus: vi.fn(),
  remoteFocus: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
  reveal: vi.fn(),
  openLog: vi.fn(),
  revealWithOutcome: vi.fn(),
  noWorkspace: false,
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
      activeWorktreeId: mocks.noWorkspace ? null : mocks.state.activeWorktreeId,
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
  activateAndRevealWorkspace: mocks.reveal,
  activateAndRevealWorkspaceWithOutcome: mocks.revealWithOutcome
}))
vi.mock('@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open', () => ({
  openAiVaultSessionLogInOrca: mocks.openLog
}))
import { openOrchestrationWorker } from './open-orchestration-worker'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'

const actualLog = await vi.importActual<{
  openAiVaultSessionLogInOrca: typeof openAiVaultSessionLogInOrca
}>('@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open')

const PANE_GONE = "Agent's pane is no longer available."

beforeEach(() => {
  vi.clearAllMocks()
  mocks.noWorkspace = false
  mocks.openLog.mockResolvedValue(true)
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
    expect(mocks.openLog).toHaveBeenCalledExactlyOnceWith(
      {
        agent: 'claude',
        filePath: TRANSCRIPT,
        executionHostId: 'local'
      },
      { notifyMissingWorkspace: false }
    )
  )
  expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerTranscript', {
    dispatch: 'ctx_done'
  })
  expect(mocks.info).not.toHaveBeenCalled()
  expect(mocks.toast).not.toHaveBeenCalled()
})

it('keeps the dead-pane notice when the worker left no log and no record places its workspace here', async () => {
  terminalGone(async () => ({ transcript: null }))
  openOrchestrationWorker(FINISHED, { kind: 'local' })
  await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledOnce())
  expect(mocks.openLog).not.toHaveBeenCalled()
})

it('keeps the dead-pane notice on a host too old to read the log when no record places its workspace here', async () => {
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

describe('a worker whose terminal is gone', () => {
  const gone = {
    dispatchId: 'ctx_gone',
    title: 'Fix pty exhaustion',
    worktreeId: 'wt-fix',
    chatSessionId: null,
    host: 'local' as const
  }

  // The order once the terminal is gone: its log, else its workspace, else the notice.
  it('opens its log first, not its workspace, when the worker left one', async () => {
    terminalGone(async () => ({ transcript: { agent: 'claude', path: TRANSCRIPT } }))
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() =>
      expect(mocks.openLog).toHaveBeenCalledExactlyOnceWith(
        {
          agent: 'claude',
          filePath: TRANSCRIPT,
          executionHostId: 'local'
        },
        { notifyMissingWorkspace: false }
      )
    )
    expect(mocks.revealWithOutcome).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('opens its workspace when there is no log to show', async () => {
    terminalGone(async () => ({ transcript: null }))
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() =>
      expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', { executionHostId: 'local' })
    )
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerTranscript', {
      dispatch: 'ctx_gone'
    })
    expect(mocks.openLog).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('falls through to its own workspace when the log opener refuses an available transcript', async () => {
    terminalGone(async () => ({ transcript: { agent: 'claude', path: TRANSCRIPT } }))
    mocks.openLog.mockImplementationOnce(actualLog.openAiVaultSessionLogInOrca)
    mocks.noWorkspace = true
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() =>
      expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', { executionHostId: 'local' })
    )
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('opens its workspace on a host too old to read the log', async () => {
    terminalGone(async () => {
      throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
    })
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() =>
      expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', { executionHostId: 'local' })
    )
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('shows the notice only after both the log and the workspace fail', async () => {
    terminalGone(async () => ({ transcript: null }))
    mocks.revealWithOutcome.mockReturnValue({
      refused: { reason: 'workspace-missing', failureNotified: false }
    })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledExactlyOnceWith(PANE_GONE, undefined))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerTranscript', {
      dispatch: 'ctx_gone'
    })
    expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', { executionHostId: 'local' })
    expect(mocks.openLog).not.toHaveBeenCalled()
  })

  it('opens its workspace, saying nothing more, when the host finds no terminal at lookup and no log', async () => {
    terminalGone(async () => ({ transcript: null }))
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() =>
      expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', { executionHostId: 'local' })
    )
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('opens its workspace on the paired computer when focus finds the terminal gone', async () => {
    mocks.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_dead' } })
    mocks.focus.mockReturnValue(false)
    mocks.remoteFocus.mockRejectedValue(
      new RuntimeRpcCallError({
        id: '1',
        ok: false,
        error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
      })
    )
    mocks.revealWithOutcome.mockReturnValue({ opened: { primaryTabId: null } })
    openOrchestrationWorker(gone, { kind: 'environment', environmentId: 'env-1' })
    await vi.waitFor(() =>
      expect(mocks.revealWithOutcome).toHaveBeenCalledWith('wt-fix', {
        executionHostId: 'runtime:env-1'
      })
    )
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('keeps the pane notice when its workspace is gone or its record does not place it here', async () => {
    terminalGone(async () => ({ transcript: null }))
    mocks.revealWithOutcome.mockReturnValue({
      refused: { reason: 'workspace-missing', failureNotified: false }
    })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledWith(PANE_GONE, undefined))

    mocks.info.mockClear()
    mocks.revealWithOutcome.mockClear()
    openOrchestrationWorker({ ...gone, host: undefined }, { kind: 'local' })
    await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledWith(PANE_GONE, undefined))
    expect(mocks.revealWithOutcome).not.toHaveBeenCalled()
  })

  it('says nothing more when opening the workspace already said why it could not', async () => {
    terminalGone(async () => ({ transcript: null }))
    mocks.revealWithOutcome.mockReturnValue({
      refused: { reason: 'workspace-missing', failureNotified: true }
    })
    openOrchestrationWorker(gone, { kind: 'local' })
    await vi.waitFor(() => expect(mocks.revealWithOutcome).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.info).not.toHaveBeenCalled()
  })
})
