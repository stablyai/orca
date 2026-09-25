import { describe, expect, it, vi } from 'vitest'

import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

describe('terminal PTY paste writer', () => {
  it('prefers acknowledged PTY writes when available', async () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const sendInputAccepted = vi.fn().mockResolvedValue(true)

    await expect(
      writeTerminalPastePtyInput({ sendInput, sendInputAccepted }, 'payload', { userInput: true })
    ).resolves.toBe(true)

    expect(sendInputAccepted).toHaveBeenCalledWith('payload', { userInput: true })
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('falls back to queued PTY writes when acknowledged writes are unavailable', () => {
    const sendInput = vi.fn().mockReturnValue(true)

    expect(writeTerminalPastePtyInput({ sendInput }, 'payload', { userInput: true })).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('payload', { userInput: true })
  })

  it('rejects writes without a transport', () => {
    expect(writeTerminalPastePtyInput(undefined, 'payload')).toBe(false)
  })
})
