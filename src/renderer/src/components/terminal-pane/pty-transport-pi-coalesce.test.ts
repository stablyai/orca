// Every coalesced OSC title must reach observers in order; keeping only the last idle title hides working frames on fast Pi turns.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

function flushPtySideEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('pty-transport — coalesced OSC titles from Pi', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((cb: (payload: { id: string; data: string }) => void) => {
            onData = cb
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('surfaces working frames even when the chunk ends with a trailing idle title', async () => {
    // Main’s batch can end with idle after multiple spinner frames; assert the intermediate working state survives.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // Batch working frames with the final agent_end idle title, matching PTY read coalescing.
    const chunk = `${workingFrame('⠋')}some response text\r\n${workingFrame('⠙')}more response text\r\n${idleTitle()}`
    onData?.({ id: 'pty-pi', data: chunk })
    await flushPtySideEffects()

    const seen = onTitleChange.mock.calls.map((c) => c[0])
    // Observers need the working edge even when the same chunk ends idle.
    expect(seen).toContain('⠋ π - cwd')
    expect(seen.at(-1)).toBe('π - cwd')

    transport.disconnect()
  })

  it('surfaces working frames when many spinner frames arrive in one chunk', async () => {
    // Delayed renderer flushes can batch many spinner frames; all must retain observer order.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    const framesChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const chunk = framesChars.map(workingFrame).join('body\r\n')
    onData?.({ id: 'pty-pi', data: chunk })
    await flushPtySideEffects()

    const seen = onTitleChange.mock.calls.map((c) => c[0])
    expect(seen).toContain('⠋ π - cwd')

    transport.disconnect()
  })
})
