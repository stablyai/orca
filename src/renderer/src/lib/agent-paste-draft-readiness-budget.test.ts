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
  inspectRuntimeTerminalProcess: testState.inspectProcess
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
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

  it('flags a blind paste when only the opencode process, not its composer, was seen', async () => {
    // ConPTY omits DECSET 2004; distinguish OpenCode’s blind-write fallback from observed delivery (#22479).
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
})
