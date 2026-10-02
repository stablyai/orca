import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ReceiptState = {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusByPaneKey: Record<string, { updatedAt: number }>
  settings: Record<string, unknown>
}

const mocks = vi.hoisted(() => {
  const empty = (): ReceiptState => ({
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {},
    settings: {}
  })
  let state = empty()
  const listeners = new Set<(next: ReceiptState) => void>()
  return {
    getState: () => state,
    setState: (next: Partial<ReceiptState>) => {
      state = { ...state, ...next }
      for (const listener of listeners) {
        listener(state)
      }
    },
    subscribe: (listener: (next: ReceiptState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: () => {
      listeners.clear()
      state = empty()
    },
    readiness: vi.fn(),
    readForeground: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
}))
vi.mock('./agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.readiness }))
vi.mock('./agent-paste-draft', () => ({
  PTY_SPAWN_TIMEOUT_MS: 8000,
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import { waitForLaunchPromptReceipt } from './agent-launch-prompt-receipt'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function receipt() {
  return waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
}

describe('whether a prompt that rode the launch command reached the agent', () => {
  beforeEach(() => {
    mocks.reset()
    mocks.setState({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } })
    mocks.readiness.mockReset().mockResolvedValue(true)
    mocks.readForeground.mockReset().mockResolvedValue('launched-agent')
    // Timers go through globalThis at call time, so fake timers reach them.
    vi.stubGlobal('window', {
      setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
      api: { pty: { readLaunchedAgentForeground: mocks.readForeground } }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is delivered when the agent’s own hook reports a turn on the tab', async () => {
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 150 } } })
    await expect(pending).resolves.toBe('delivered')
  })

  // Why: #24257's crash-guard predicate, asked once the agent looks ready.
  it('is delivered when a fresh read finds the launched agent in front', async () => {
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await expect(pending).resolves.toBe('delivered')
    expect(mocks.readForeground).toHaveBeenCalledWith('pty-1', 'claude')
    expect(mocks.readiness.mock.calls[0]?.[4]).toEqual({ revokeOnBracketedPasteOff: true })
  })

  // Why: the agent had the prompt on its line and quit at startup, before reading it. Only the
  // agent itself seen in front, then the shell, proves that.
  it('reports the agent exited when the agent was seen in front and then the shell', async () => {
    vi.useFakeTimers()
    let ready: () => void = () => {}
    mocks.readiness.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)))
    mocks.readForeground.mockResolvedValueOnce('launched-agent').mockResolvedValue('shell')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(250)
    ready()
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toBe('agent-exited')
  })

  // Why (stack QA, slow shell startup): the shell drew its prompt and looked ready before it ran
  // the launch line, and one read finding it in front was taken for an agent that had exited.
  it('keeps reading through a slow shell startup until the agent is in front', async () => {
    vi.useFakeTimers()
    let ready: () => void = () => {}
    mocks.readiness.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)))
    // The shell's startup file runs `sleep` in front, then the shell draws its prompt (and looks
    // ready) before it runs the launch line, then the agent starts.
    mocks.readForeground
      .mockResolvedValueOnce('other')
      .mockResolvedValueOnce('shell')
      .mockResolvedValueOnce('shell')
      .mockResolvedValueOnce('shell')
      .mockResolvedValue('launched-agent')
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 50 } } })
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(100)
    ready()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBe('delivered')
    expect(mocks.readForeground.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('is unconfirmed, never exited, when the shell stays in front with no sign the agent ran', async () => {
    vi.useFakeTimers()
    mocks.readForeground.mockResolvedValue('shell')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    let settled: string | null = null
    void pending.then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(settled).toBe('unconfirmed')
    // Why: each read forks a `ps`; backed off, the whole wait costs a few dozen, not 120.
    expect(mocks.readForeground.mock.calls.length).toBeLessThanOrEqual(20)
  })

  // Why: #24257's predicate finds an agent behind a wrapper or a command override as another
  // process; once the agent looks ready that counts as delivered, as before.
  it('is delivered on another process in front once the agent looks ready', async () => {
    mocks.readForeground.mockResolvedValue('other')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await expect(pending).resolves.toBe('delivered')
  })

  it('does not count another process as the agent having run', async () => {
    vi.useFakeTimers()
    let ready: () => void = () => {}
    mocks.readiness.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)))
    mocks.readForeground.mockResolvedValueOnce('other').mockResolvedValue('shell')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(300)
    ready()
    let settled: string | null = null
    void pending.then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBeNull()
  })

  it('is unconfirmed when the host cannot tell and no hook turn arrives', async () => {
    vi.useFakeTimers()
    mocks.readForeground.mockResolvedValue('unknown')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toBe('unconfirmed')
  })

  it('takes a hook turn that arrives after a read that could not tell', async () => {
    vi.useFakeTimers()
    mocks.readForeground.mockResolvedValue('unknown')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(500)
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 600 } } })
    await expect(pending).resolves.toBe('delivered')
  })

  it('reports the agent exited when the PTY exits after the agent was seen', async () => {
    vi.useFakeTimers()
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(0)
    mocks.setState({ ptyIdsByTabId: { 'tab-1': [] } })
    await expect(pending).resolves.toBe('agent-exited')
  })

  it('is unconfirmed when the PTY exits before the agent was ever seen', async () => {
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    mocks.readForeground.mockReturnValue(new Promise(() => {}))
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': [] } })
    await expect(pending).resolves.toBe('unconfirmed')
  })

  it('is not delivered when the PTY never spawns, as when the host refused its launch file', async () => {
    vi.useFakeTimers()
    const pending = receipt()
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(pending).resolves.toBe('not-delivered')
    expect(mocks.readForeground).not.toHaveBeenCalled()
  })

  it('is not delivered when the tab closes first', async () => {
    const pending = receipt()
    mocks.setState({ tabsByWorktree: { 'wt-1': [] } })
    await expect(pending).resolves.toBe('not-delivered')
  })

  // Why (final review P3-3): the launch seeds Command Code's working row from its own prompt.
  it('does not take Command Code’s seeded status row as its turn', async () => {
    vi.useFakeTimers()
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    mocks.readForeground.mockResolvedValue('shell')
    const pending = waitForLaunchPromptReceipt({
      tabId: 'tab-1',
      agent: 'command-code',
      launchedAt: 100
    })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 150 } } })
    let settled: string | null = null
    void pending.then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBeNull()
  })
})
