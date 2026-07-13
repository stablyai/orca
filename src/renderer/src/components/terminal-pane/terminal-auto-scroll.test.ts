import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { followTerminalOutput, pinTerminalOutput } from './terminal-auto-scroll'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  cancelDeferredScrollRestore: vi.fn(() => mocks.calls.push('cancel')),
  markTerminalFollowOutput: vi.fn(() => mocks.calls.push('mark')),
  markTerminalPinnedViewport: vi.fn(() => mocks.calls.push('pin')),
  syncTerminalScrollIntentFromViewport: vi.fn(() => mocks.calls.push('sync'))
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  cancelDeferredScrollRestore: mocks.cancelDeferredScrollRestore
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  markTerminalFollowOutput: mocks.markTerminalFollowOutput,
  markTerminalPinnedViewport: mocks.markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport: mocks.syncTerminalScrollIntentFromViewport
}))

function createTerminal(scrollError?: Error): Terminal {
  return {
    scrollToBottom: vi.fn(() => {
      mocks.calls.push('scroll')
      if (scrollError) {
        throw scrollError
      }
    }),
    focus: vi.fn(() => mocks.calls.push('focus'))
  } as unknown as Terminal
}

describe('terminal auto-scroll', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    vi.clearAllMocks()
  })

  it('cancels stale restores before following, scrolling, syncing, and focusing', () => {
    const terminal = createTerminal()

    followTerminalOutput(terminal, { focus: true })

    expect(mocks.calls).toEqual(['cancel', 'mark', 'scroll', 'sync', 'focus'])
    expect(mocks.cancelDeferredScrollRestore).toHaveBeenCalledWith(terminal)
    expect(mocks.markTerminalFollowOutput).toHaveBeenCalledWith(terminal)
    expect(mocks.syncTerminalScrollIntentFromViewport).toHaveBeenCalledWith(terminal)
  })

  it('keeps follow intent without resyncing when xterm dimensions are detached', () => {
    const terminal = createTerminal(
      new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    )

    expect(() => followTerminalOutput(terminal, { focus: true })).not.toThrow()
    expect(mocks.calls).toEqual(['cancel', 'mark', 'scroll', 'focus'])
  })

  it('surfaces unrelated scroll failures without syncing or focusing', () => {
    const terminal = createTerminal(new TypeError('unexpected failure'))

    expect(() => followTerminalOutput(terminal, { focus: true })).toThrow('unexpected failure')
    expect(mocks.calls).toEqual(['cancel', 'mark', 'scroll'])
  })

  it('cancels stale restores before pinning the current viewport', () => {
    const terminal = createTerminal()

    pinTerminalOutput(terminal)

    expect(mocks.calls).toEqual(['cancel', 'pin'])
    expect(mocks.markTerminalPinnedViewport).toHaveBeenCalledWith(terminal)
  })
})
