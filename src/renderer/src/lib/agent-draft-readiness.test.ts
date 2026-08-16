import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyData,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData
} from '@/components/terminal-pane/pty-pre-handler-buffer'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'

const testState = vi.hoisted(() => ({
  observer: null as ((data: string) => void) | null,
  unsubscribe: vi.fn()
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_ptyId: string, observer: (data: string) => void) => {
    testState.observer = observer
    return testState.unsubscribe
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

const PTY_ID = 'pty-buffered-codex'
const CODEX_COMPOSER = '\x1b[?1049h\x1b[1m›\x1b[0m Implement {feature}'
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'

describe('waitForAgentDraftInputReady', () => {
  afterEach(() => {
    clearPreHandlerPtyState(PTY_ID)
    testState.observer = null
    testState.unsubscribe.mockReset()
    vi.useRealTimers()
  })

  it('observes buffered startup bytes without consuming the primary drain', async () => {
    vi.useFakeTimers()
    bufferPreHandlerPtyData(PTY_ID, CODEX_COMPOSER)
    bufferPreHandlerPtyData(PTY_ID, DECSET_BRACKETED_PASTE)
    const primary = vi.fn()

    await expect(
      waitForAgentDraftInputReady(PTY_ID, 20_000, 'codex-composer-prompt', {})
    ).resolves.toBe(true)
    drainPreHandlerPtyData(PTY_ID, primary)

    expect(testState.unsubscribe).toHaveBeenCalledOnce()
    expect(primary.mock.calls).toEqual([
      [CODEX_COMPOSER, undefined],
      [DECSET_BRACKETED_PASTE, undefined]
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
