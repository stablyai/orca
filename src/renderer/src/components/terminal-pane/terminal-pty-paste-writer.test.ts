import { describe, expect, it, vi } from 'vitest'

import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

describe('terminal PTY paste writer', () => {
  it.each(['rejects', 'throws', 'pending'] as const)(
    'preserves accepted input when retirement %s',
    async (failure) => {
      const sendInputAccepted = vi.fn().mockResolvedValue(true)
      const retireInputOperation = vi.fn(() => {
        if (failure === 'throws') {throw new Error('cleanup failed')}
        if (failure === 'rejects') {return Promise.reject(new Error('cleanup failed'))}
        return new Promise<boolean>(() => {})
      })
      await expect(
        writeTerminalPastePtyInput(
          { sendInput: vi.fn(), sendInputAccepted, retireInputOperation },
          'payload',
          { operationId: 'accepted' }
        )
      ).resolves.toBe(true)
      expect(sendInputAccepted).toHaveBeenCalledOnce()
      expect(retireInputOperation).toHaveBeenCalledWith('accepted')
    }
  )
  it('prefers acknowledged PTY writes when available', async () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const sendInputAccepted = vi.fn().mockResolvedValue(true)

    await expect(
      writeTerminalPastePtyInput({ sendInput, sendInputAccepted }, 'payload')
    ).resolves.toBe(true)

    expect(sendInputAccepted).toHaveBeenCalledWith('payload')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('falls back to queued PTY writes when acknowledged writes are unavailable', () => {
    const sendInput = vi.fn().mockReturnValue(true)

    expect(writeTerminalPastePtyInput({ sendInput }, 'payload')).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('payload')
  })

  it('rejects writes without a transport', () => {
    expect(writeTerminalPastePtyInput(undefined, 'payload')).toBe(false)
  })

  it('retires a retry-aware write only after settlement', async () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const sendInputAccepted = vi.fn().mockResolvedValue(true)
    const retireInputOperation = vi.fn().mockResolvedValue(true)
    await expect(
      writeTerminalPastePtyInput(
        { sendInput, sendInputAccepted, retireInputOperation },
        'payload',
        {
          operationId: 'paste-1'
        }
      )
    ).resolves.toBe(true)
    expect(sendInputAccepted).toHaveBeenCalledWith('payload', { operationId: 'paste-1' })
    expect(retireInputOperation).toHaveBeenCalledWith('paste-1')
  })

  it('does not retire a rejected retry-aware write', async () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const sendInputAccepted = vi.fn().mockResolvedValue(false)
    const retireInputOperation = vi.fn().mockResolvedValue(true)
    await expect(
      writeTerminalPastePtyInput(
        { sendInput, sendInputAccepted, retireInputOperation },
        'payload',
        {
          operationId: 'paste-2'
        }
      )
    ).resolves.toBe(false)
    expect(retireInputOperation).not.toHaveBeenCalled()
  })

  it('does not retire an operation that was only admitted to a fire-and-forget queue', () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const retireInputOperation = vi.fn().mockResolvedValue(true)

    expect(
      writeTerminalPastePtyInput({ sendInput, retireInputOperation }, 'payload', {
        operationId: 'paste-3'
      })
    ).toBe(true)
    expect(retireInputOperation).not.toHaveBeenCalled()
  })
})
