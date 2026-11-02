import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady, pasteDraftWhenAgentReady } from './agent-paste-draft'

const testState = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = { 'tab-1': ['pty-1'] }
  return {
    waitForReady: vi.fn(),
    inspectProcess: vi.fn(),
    sendInput: vi.fn(),
    ptyIdsByTabId,
    listeners: new Set<(state: unknown) => void>()
  }
})

function storeState() {
  return { settings: {}, tabsByWorktree: {}, ptyIdsByTabId: testState.ptyIdsByTabId }
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: storeState,
    subscribe: (listener: (state: unknown) => void) => {
      testState.listeners.add(listener)
      return () => testState.listeners.delete(listener)
    }
  }
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: testState.waitForReady
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: testState.inspectProcess,
  sendRuntimePtyInputVerified: testState.sendInput
}))

describe('pty-bound agent draft readiness budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.waitForReady.mockReset()
    testState.waitForReady.mockImplementation(
      (_ptyId: string, timeoutMs: number) =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(timeoutMs >= 10_000), Math.min(timeoutMs, 10_000))
        })
    )
    testState.inspectProcess.mockReset()
    testState.inspectProcess.mockResolvedValue({
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })
    testState.sendInput.mockReset()
    testState.sendInput.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('delivers when a cold Codex composer becomes ready after 8s', async () => {
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'codex',
      forcePaste: true
    })

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promise).resolves.toBe(true)
    expect(testState.waitForReady).toHaveBeenCalledWith('pty-1', 20_000, 'codex-composer-prompt')
    expect(testState.sendInput).toHaveBeenCalledTimes(1)
  })

  it('gives a cold opencode composer the same headroom as Codex', async () => {
    const onUnconfirmedDelivery = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'opencode',
      forcePaste: true,
      onUnconfirmedDelivery
    })

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promise).resolves.toBe(true)
    expect(testState.waitForReady).toHaveBeenCalledWith(
      'pty-1',
      20_000,
      'render-cursor-after-bracketed-paste'
    )
    expect(testState.sendInput).toHaveBeenCalledTimes(1)
    expect(onUnconfirmedDelivery).not.toHaveBeenCalled()
  })

  it.each(['opencode', 'opencode2'] as const)(
    'waits for the %s agent row only when Enter follows the paste',
    async (agent) => {
      const promise = pasteDraftToAgentPtyWhenReady({
        ptyId: 'pty-1',
        content: 'task',
        agent,
        submit: true,
        forcePaste: true
      })

      await vi.advanceTimersByTimeAsync(12_000)

      await expect(promise).resolves.toBe(true)
      expect(testState.waitForReady).toHaveBeenCalledWith('pty-1', 20_000, 'opencode-agent-row')
    }
  )

  it.each([
    ['opencode', true, 'opencode-agent-row'],
    ['opencode2', true, 'opencode-agent-row'],
    ['opencode', false, 'render-cursor-after-bracketed-paste'],
    ['opencode2', false, 'render-cursor-after-bracketed-paste']
  ] as const)('a tab-bound %s paste with submit %s waits on %s', async (agent, submit, signal) => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: 'task',
      agent,
      submit,
      forcePaste: true
    })

    await vi.advanceTimersByTimeAsync(12_000)

    await expect(promise).resolves.toBe(true)
    expect(testState.waitForReady).toHaveBeenCalledWith('pty-1', 20_000, signal)
  })

  it('flags a blind paste when only the opencode process, not its composer, was seen', async () => {
    // Regression (#22479): ConPTY never forwards DECSET 2004, so on Windows this is the only
    // path opencode can take. Callers must be able to tell it apart from a real delivery.
    testState.waitForReady.mockResolvedValue(false)
    testState.inspectProcess.mockResolvedValue({
      foregroundProcess: 'opencode',
      hasChildProcesses: false
    })
    const onUnconfirmedDelivery = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'opencode',
      forcePaste: true,
      onUnconfirmedDelivery
    })

    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendInput).toHaveBeenCalledTimes(1)
    expect(onUnconfirmedDelivery).toHaveBeenCalledTimes(1)
  })

  // An AI button's pane may settle its grid for longer than the spawn budget before it spawns.
  it.each([true, false])(
    'delivers once the pane says whether it started, however late (%s)',
    async (started) => {
      testState.waitForReady.mockResolvedValue(true)
      let answer!: (startedPtyId: string | null) => void
      const promise = pasteDraftWhenAgentReady({
        tabId: 'tab-late',
        content: 'task',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        launchPty: new Promise<string | null>((resolve) => {
          answer = resolve
        })
      })

      await vi.advanceTimersByTimeAsync(13_000)
      testState.ptyIdsByTabId['tab-late'] = ['pty-late']
      testState.listeners.forEach((listener) => listener(storeState()))
      answer(started ? 'pty-late' : null)
      await vi.advanceTimersByTimeAsync(12_000)

      await expect(promise).resolves.toBe(started)
      const writes = testState.sendInput.mock.calls.map((call) => String(call[1]))
      expect(writes.filter((data) => data.includes('task'))).toHaveLength(started ? 1 : 0)
      expect(writes.filter((data) => data === '\r')).toHaveLength(started ? 1 : 0)
      expect(writes).toHaveLength(started ? 2 : 0)
    }
  )

  it('keeps the 8s readiness deadline for agents without an agent-specific budget', async () => {
    const onTimeout = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'gemini',
      forcePaste: true,
      onTimeout
    })

    await vi.advanceTimersByTimeAsync(9000)

    await expect(promise).resolves.toBe(false)
    expect(testState.waitForReady).toHaveBeenCalledWith(
      'pty-1',
      8000,
      'render-quiet-after-bracketed-paste'
    )
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendInput).not.toHaveBeenCalled()
  })
})
