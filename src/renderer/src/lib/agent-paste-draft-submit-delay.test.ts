import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_PASTE_SUBMIT_DELAY_MS,
  resolvePostPasteSubmitDelayMs,
  sendBracketedPasteToRunningAgent
} from './agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

const testState = vi.hoisted(() => ({
  sendRuntimePtyInputVerified: vi.fn()
}))
const CODEX_SUBMIT_RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs ?? 0

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: vi.fn(() => false),
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified,
  inspectRuntimeTerminalProcess: vi.fn()
}))

describe('post-paste submit delay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('resolves per agent, falling back to the shared default', () => {
    expect(resolvePostPasteSubmitDelayMs('codex')).toBe(300)
    expect(resolvePostPasteSubmitDelayMs('claude')).toBe(POST_PASTE_SUBMIT_DELAY_MS)
    expect(resolvePostPasteSubmitDelayMs()).toBe(POST_PASTE_SUBMIT_DELAY_MS)
  })

  it.each([
    ['codex' as const, 300],
    [undefined, POST_PASTE_SUBMIT_DELAY_MS]
  ])('holds Enter for the %s delay after the paste', async (agent, delayMs) => {
    const promise = sendBracketedPasteToRunningAgent({ ptyId: 'pty-1', content: 'hi', agent })
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    if (agent === 'codex') {
      await vi.advanceTimersByTimeAsync(CODEX_SUBMIT_RETRY_DELAY_MS)
    }
    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(2, {}, 'pty-1', '\r')
  })
})
