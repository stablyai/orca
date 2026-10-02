import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferPreHandlerPtyData,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData
} from '@/components/terminal-pane/pty-pre-handler-buffer'
import { bracketedPasteStateAfter, waitForAgentDraftInputReady } from './agent-draft-readiness'

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

  // Why: a shell running the launch line turns bracketed paste off, so its earlier prompt must not
  // read as the agent ready once the line is running.
  describe('with bracketed paste turned off revoking the quiet window', () => {
    const quietTimers = (): void => {
      vi.useFakeTimers()
      vi.stubGlobal('window', {
        setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer)
      })
    }
    afterEach(() => vi.unstubAllGlobals())

    it('waits for the agent to turn it on again', async () => {
      quietTimers()
      let ready: boolean | null = null
      void waitForAgentDraftInputReady(
        PTY_ID,
        20_000,
        'render-quiet-after-bracketed-paste',
        {},
        {
          revokeOnBracketedPasteOff: true
        }
      ).then((value) => {
        ready = value
      })
      testState.observer?.('$ \x1b[?2004h')
      testState.observer?.('claude "fix it"\r\n\x1b[?2004l')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(ready).toBeNull()
      testState.observer?.('\x1b[?2004h> ')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(ready).toBe(true)
    })

    it('leaves a caller that did not ask for it on the shell prompt’s quiet window', async () => {
      quietTimers()
      const pending = waitForAgentDraftInputReady(
        PTY_ID,
        20_000,
        'render-quiet-after-bracketed-paste',
        {}
      )
      testState.observer?.('$ \x1b[?2004h')
      testState.observer?.('\x1b[?2004l')
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(pending).resolves.toBe(true)
    })

    it('reads the last toggle in a chunk', () => {
      expect(bracketedPasteStateAfter(true, 'a\x1b[?2004lb')).toBe(false)
      expect(bracketedPasteStateAfter(false, '\x1b[?2004l\x1b[?2004h')).toBe(true)
      expect(bracketedPasteStateAfter(false, 'plain')).toBe(false)
    })
  })
})
