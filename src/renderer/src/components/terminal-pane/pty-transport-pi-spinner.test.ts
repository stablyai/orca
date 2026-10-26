// Pi OSC spinner frames must reach onTitleChange in the normalized form used by worktree-card status, including after reattach.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

function flushPtySideEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createIpcPtyTransport — Pi titlebar spinner signal', () => {
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

  it('surfaces normalized working and idle labels across a spinner cycle', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // Deliver idle→working→idle as separate chunks, matching captured live-session ordering.
    onData?.({ id: 'pty-pi', data: idleTitle() })
    onData?.({ id: 'pty-pi', data: workingFrame('⠋') }) // ⠋
    onData?.({ id: 'pty-pi', data: workingFrame('⠙') }) // ⠙
    onData?.({ id: 'pty-pi', data: workingFrame('⠹') }) // ⠹
    onData?.({ id: 'pty-pi', data: idleTitle() })
    await flushPtySideEffects()

    const normalized = onTitleChange.mock.calls.map((c) => c[0])
    // Require a normalized working frame so the store/card can observe the active turn.
    expect(normalized).toContain('⠋ π - cwd')
    expect(normalized).toContain('π - cwd')

    transport.disconnect()
  })

  it('surfaces working even when a single chunk contains multiple spinner frames', async () => {
    // Batched spinner chunks must surface working before agent_end; final-idle coalescing has dedicated ordered-frame coverage.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    const coalescedWorking = `${workingFrame('⠋')}output\r\n${workingFrame('⠙')}`
    onData?.({ id: 'pty-pi', data: coalescedWorking })
    await flushPtySideEffects()

    const calls = onTitleChange.mock.calls.map((c) => c[0])
    expect(calls).toContain('⠋ π - cwd')

    transport.disconnect()
  })
})
