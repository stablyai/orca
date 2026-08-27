import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady } from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  waitForReady: vi.fn(),
  inspectProcess: vi.fn(),
  sendInput: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, tabsByWorktree: {} })
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
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'codex',
      forcePaste: true
    })

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promise).resolves.toBe(true)
    expect(testState.waitForReady).toHaveBeenCalledWith(
      'pty-1',
      20_000,
      'codex-composer-prompt',
      {}
    )
    expect(testState.sendInput).toHaveBeenCalledTimes(1)
  })

  it('keeps the 8s readiness deadline for non-Codex agents', async () => {
    const onTimeout = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'opencode',
      forcePaste: true,
      onTimeout
    })

    await vi.advanceTimersByTimeAsync(9000)

    await expect(promise).resolves.toBe(false)
    expect(testState.waitForReady).toHaveBeenCalledWith(
      'pty-1',
      8000,
      'render-cursor-after-bracketed-paste',
      {}
    )
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendInput).not.toHaveBeenCalled()
  })
})
