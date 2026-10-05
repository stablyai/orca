import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyOutputProcessor } from './pty-output-processor'

afterEach(() => {
  vi.useRealTimers()
})

describe('renderer byte parser exit origin (R4.2-1)', () => {
  it('stamps an exit with the time its bytes arrived, not the time the queue drained', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const onAgentExited = vi.fn()
    const processor = createPtyOutputProcessor({
      onTitleChange: vi.fn(),
      onAgentBecameIdle: vi.fn(),
      onAgentBecameWorking: vi.fn(),
      onAgentExited
    })
    processor.processData('\x1b]0;✳ Claude Code\x07', {})
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(2_000)
    // The neutral title is queued at 2 s; the drain runs after the user's switch at 5 s.
    processor.processData('\x1b]0;zsh\x07', {})
    vi.setSystemTime(5_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(onAgentExited).toHaveBeenCalledWith({ observedAtMs: 2_000 })
  })
})
