import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockSubscribeTerminal = vi.fn()
const mockCallRuntimeRpc = vi.fn()

const state = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    terminalMainSideEffectAuthority: undefined as boolean | undefined
  },
  setAgentStatus: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state
  }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mockCallRuntimeRpc,
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/runtime/remote-runtime-terminal-multiplexer', () => ({
  getRemoteRuntimeTerminalMultiplexer: () => ({ subscribeTerminal: mockSubscribeTerminal })
}))

const DONE_STATUS_OSC = '\x1b]9999;{"state":"done","prompt":"ok","agentType":"codex"}\x07'

describe('observeExistingAutomationSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.settings = {
      activeRuntimeEnvironmentId: null,
      terminalMainSideEffectAuthority: undefined
    }
    mockSubscribeToPtyData.mockReturnValue(vi.fn())
    mockSubscribeToPtyExit.mockReturnValue(vi.fn())
    mockCallRuntimeRpc.mockReturnValue(new Promise(() => {}))
    mockSubscribeTerminal.mockResolvedValue({ close: vi.fn() })
  })

  it('skips the duplicate OSC store write for local PTYs under main authority', async () => {
    // Why: main already parses OSC 9999 for local/SSH PTYs and routes it to
    // the store via agentStatus:set; writing here too would race that path.
    const onAgentStatus = vi.fn()
    const { observeExistingAutomationSession } = await import('./automation-session-observer')

    await observeExistingAutomationSession({
      ptyId: 'pty-local-1',
      paneKey: 'tab-1:leaf-1',
      runId: 'run-1',
      onData: vi.fn(),
      onAgentStatus,
      onExit: vi.fn()
    })

    const handleData = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
    handleData(DONE_STATUS_OSC)

    expect(state.setAgentStatus).not.toHaveBeenCalled()
    expect(onAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' })
    )
  })

  it('keeps the legacy OSC store write when the kill switch is off', async () => {
    state.settings.terminalMainSideEffectAuthority = false
    const onAgentStatus = vi.fn()
    const { observeExistingAutomationSession } = await import('./automation-session-observer')

    await observeExistingAutomationSession({
      ptyId: 'pty-local-1',
      paneKey: 'tab-1:leaf-1',
      runId: 'run-1',
      onData: vi.fn(),
      onAgentStatus,
      onExit: vi.fn()
    })

    const handleData = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
    handleData(DONE_STATUS_OSC)

    expect(state.setAgentStatus).toHaveBeenCalledWith(
      'tab-1:leaf-1',
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' }),
      undefined
    )
    expect(onAgentStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps the OSC store write for remote-runtime PTYs (bytes never transit local main)', async () => {
    const onAgentStatus = vi.fn()
    const { observeExistingAutomationSession } = await import('./automation-session-observer')

    await observeExistingAutomationSession({
      ptyId: 'remote:env-1@@terminal-9',
      paneKey: 'tab-1:leaf-1',
      runId: 'run-1',
      onData: vi.fn(),
      onAgentStatus,
      onExit: vi.fn()
    })

    expect(mockSubscribeTerminal).toHaveBeenCalledTimes(1)
    const callbacks = mockSubscribeTerminal.mock.calls[0]?.[0]?.callbacks as {
      onData: (data: string) => void
    }
    callbacks.onData(DONE_STATUS_OSC)

    expect(state.setAgentStatus).toHaveBeenCalledWith(
      'tab-1:leaf-1',
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' }),
      undefined
    )
    expect(onAgentStatus).toHaveBeenCalledTimes(1)
  })
})
