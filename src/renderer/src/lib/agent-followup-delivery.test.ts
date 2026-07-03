import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn()
}))

describe('sendFollowupPromptWhenAgentReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(inspectRuntimeTerminalProcess).mockReset()
    vi.mocked(sendRuntimePtyInputVerified).mockReset()
    vi.mocked(sendRuntimePtyInputVerified).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the follow-up once the expected agent owns the PTY', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await expect(
      sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess: 'codex',
        prompt: 'review this',
        settings: { activeRuntimeEnvironmentId: 'runtime-1' }
      })
    ).resolves.toBe(true)

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'pty-1',
      'review this\r'
    )
  })

  it('honors the readiness deadline when process inspection hangs', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockReturnValue(new Promise(() => {}))

    const promise = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'codex',
      prompt: 'review this',
      settings: { activeRuntimeEnvironmentId: 'runtime-1' }
    })

    // Why: stay just under the 4.5s readiness budget; delivery must not resolve early.
    await vi.advanceTimersByTimeAsync(4_499)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    // Why: crossing the budget boundary must resolve false without writing.
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(false)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('ignores transient inspection failures while budget remains and sends once after a match', async () => {
    vi.mocked(inspectRuntimeTerminalProcess)
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockRejectedValueOnce(new Error('pty not ready'))
      .mockResolvedValue({
        foregroundProcess: 'codex',
        hasChildProcesses: true
      })

    const promise = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'codex',
      prompt: 'review this',
      settings: { activeRuntimeEnvironmentId: 'runtime-1' }
    })

    await vi.advanceTimersByTimeAsync(300)

    await expect(promise).resolves.toBe(true)
    expect(inspectRuntimeTerminalProcess).toHaveBeenCalledTimes(3)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'pty-1',
      'review this\r'
    )
  })

  it.each([
    {
      name: 'repeated transient failures',
      setupInspection: () => {
        vi.mocked(inspectRuntimeTerminalProcess).mockRejectedValue(new Error('runtime unavailable'))
      }
    },
    {
      name: 'non-matching foreground processes',
      setupInspection: () => {
        vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
          foregroundProcess: 'bash',
          hasChildProcesses: false
        })
      }
    }
  ])(
    'returns false by the deadline for $name and never writes to the PTY',
    async ({ setupInspection }) => {
      setupInspection()

      const promise = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess: 'codex',
        prompt: 'review this',
        settings: { activeRuntimeEnvironmentId: 'runtime-1' }
      })

      // Why: stay just under the 4.5s readiness budget; delivery must not resolve early.
      await vi.advanceTimersByTimeAsync(4_499)
      expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()

      // Why: crossing the budget boundary must resolve false without writing.
      await vi.advanceTimersByTimeAsync(1)

      await expect(promise).resolves.toBe(false)
      expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    }
  )
})
