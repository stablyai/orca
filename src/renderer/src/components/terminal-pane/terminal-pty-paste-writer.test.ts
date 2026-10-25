import { describe, expect, it, vi } from 'vitest'

import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

describe('terminal PTY paste writer', () => {
  it('prefers acknowledged PTY writes when available', async () => {
    const sendInput = vi.fn().mockReturnValue(true)
    const sendInputAccepted = vi.fn().mockResolvedValue(true)

    await expect(
      writeTerminalPastePtyInput({ sendInput, sendInputAccepted }, 'payload', 'driving')
    ).resolves.toBe(true)

    expect(sendInputAccepted).toHaveBeenCalledWith('payload', 'driving')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('lets the caller withdraw an acknowledged write it stopped waiting for', async () => {
    const sendInputAccepted = vi.fn().mockResolvedValue(true)
    const controller = new AbortController()

    await writeTerminalPastePtyInput(
      { sendInput: vi.fn(), sendInputAccepted },
      'payload',
      'driving',
      controller.signal
    )

    expect(sendInputAccepted).toHaveBeenCalledWith('payload', 'driving', {
      signal: controller.signal
    })
  })

  it('falls back to queued PTY writes when acknowledged writes are unavailable', () => {
    const sendInput = vi.fn().mockReturnValue(true)

    expect(writeTerminalPastePtyInput({ sendInput }, 'payload', 'driving')).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('payload', 'driving')
  })

  it('rejects writes without a transport', () => {
    expect(writeTerminalPastePtyInput(undefined, 'payload', 'driving')).toBe(false)
  })
})
