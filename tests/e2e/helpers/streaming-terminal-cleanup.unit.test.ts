import { describe, expect, it, vi } from 'vitest'
import { closeStreamingTerminals } from './streaming-terminal-cleanup'

describe('closeStreamingTerminals', () => {
  it('force-closes a streaming PTY when tab cleanup fails', async () => {
    const call = vi.fn(async (method: string, terminal: string) => {
      if (method === 'terminal.closeTab' && terminal === 'term_a') {
        throw new Error('renderer unavailable')
      }
    })

    await expect(closeStreamingTerminals(['term_a', 'term_b'], call)).resolves.toBeUndefined()

    expect(call).toHaveBeenCalledWith('terminal.closeTab', 'term_a')
    expect(call).toHaveBeenCalledWith('terminal.close', 'term_a')
    expect(call).toHaveBeenCalledWith('terminal.closeTab', 'term_b')
  })

  it('waits for every fallback and reports terminals that could not be stopped', async () => {
    const call = vi.fn(async () => {
      throw new Error('runtime frozen')
    })

    await expect(closeStreamingTerminals(['term_a', 'term_b'], call)).rejects.toThrow(
      'Failed to close 2 streaming terminal(s)'
    )
    expect(call).toHaveBeenCalledTimes(4)
  })
})
