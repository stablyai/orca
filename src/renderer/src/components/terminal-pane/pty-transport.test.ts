import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit: ((payload: { id: string; code: number }) => void) | null = null
  let onOpenCodeStatus:
    | ((payload: { ptyId: string; status: 'working' | 'idle' | 'permission' }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onExit = null
    onOpenCodeStatus = null

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          }),
          onOpenCodeStatus: vi.fn(
            (
              callback: (payload: {
                ptyId: string
                status: 'working' | 'idle' | 'permission'
              }) => void
            ) => {
              onOpenCodeStatus = callback
              return () => {}
            }
          )
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

  it('maps OpenCode status events into the existing working to idle agent lifecycle', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onAgentBecameWorking = vi.fn()
    const onAgentBecameIdle = vi.fn()

    const transport = createIpcPtyTransport({
      onTitleChange,
      onAgentBecameWorking,
      onAgentBecameIdle
    })

    await transport.connect({
      url: '',
      callbacks: {}
    })

    expect(onOpenCodeStatus).not.toBeNull()

    onOpenCodeStatus?.({ ptyId: 'pty-1', status: 'working' })
    onData?.({ id: 'pty-1', data: '\u001b]0;OpenCode\u0007' })
    onOpenCodeStatus?.({ ptyId: 'pty-1', status: 'idle' })

    expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)
    expect(onAgentBecameIdle).toHaveBeenCalledWith('OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(1, '⠋ OpenCode', '⠋ OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(2, '⠋ OpenCode', '⠋ OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(3, 'OpenCode', 'OpenCode')
    expect(onData).not.toBeNull()
    expect(onExit).not.toBeNull()
  })

  it('does not fire unread-side effects when replaying buffered data during attach', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onAgentBecameIdle = vi.fn()
    const onBell = vi.fn()

    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: '\u001b]0;. Claude working\u0007\u001b]0;* Claude done\u0007\u0007'
    })

    const transport = createIpcPtyTransport({
      onTitleChange,
      onAgentBecameIdle,
      onBell
    })

    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })

    expect(handle.flush()).toBe('')
    expect(onTitleChange).toHaveBeenCalledWith('* Claude done', '* Claude done')
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
  })
})
