import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInput } from '../input/runtime-terminal-input-send'
import { sendRuntimePtyInputVerified } from '../input/runtime-terminal-verified-input'

function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(4_194_305)
}

describe('runtime terminal owner routing', () => {
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        pty: {
          write: localWrite,
          writeAccepted: localWriteAccepted
        }
      }
    })
  })

  it('drops byte-oversized fire-and-forget input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()

      expect(sendRuntimePtyInput('local-pty', text, 'driving')).toBe(true)

      await vi.runAllTimersAsync()

      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects byte-oversized verified input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()
      const accepted = sendRuntimePtyInputVerified('local-pty', text, 'driving')

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(false)
      expect(localWriteAccepted).not.toHaveBeenCalled()
      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
