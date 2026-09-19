import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStartupTiming } from './terminal-startup-timing'

const record = vi.hoisted(() => vi.fn())
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: record }))

function fixture(enabled = true, failure?: 'subscribe' | 'dispose') {
  vi.stubGlobal('localStorage', { getItem: () => (enabled ? '1' : null) })
  let current = true
  let ptyId = 'pty-1'
  let render: (() => void) | undefined
  const dispose = vi.fn(() => {
    if (failure === 'dispose') {
      throw new Error('disposed terminal')
    }
  })
  const onRender = vi.fn((callback: () => void) => {
    if (failure === 'subscribe') {
      throw new Error('unavailable renderer')
    }
    render = callback
    return { dispose }
  })
  const timing = createTerminalStartupTiming({
    paneKey: 'tab:pane',
    generation: 1,
    getPtyId: () => ptyId,
    isCurrent: () => current,
    isForeground: () => true,
    onRender
  })
  return {
    timing,
    onRender,
    dispose,
    render: () => render?.(),
    retire: () => {
      current = false
      ptyId = 'successor'
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('document', { visibilityState: 'hidden' })
  record.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opt-in terminal startup diagnostics', () => {
  it('allocates no timer or subscription while disabled', () => {
    const f = fixture(false)
    expect(f.timing).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.onRender).not.toHaveBeenCalled()
  })

  it('separates early control data, queue delay, parsing and later connection', () => {
    const f = fixture()
    vi.advanceTimersByTime(10)
    f.timing?.mark('liveData')
    vi.advanceTimersByTime(20)
    const write = f.timing?.firstWrite()
    vi.advanceTimersByTime(1000)
    expect(record).not.toHaveBeenCalled()
    write?.beforeWrite()
    f.render()
    vi.advanceTimersByTime(5)
    write?.onParsed()
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5)
    f.timing?.mark('connected')
    expect(record).toHaveBeenCalledWith(
      'terminal_startup_timing',
      expect.objectContaining({
        liveData: 10,
        submitted: 30,
        writeStarted: 1030,
        renderEvent: 1030,
        parsed: 1035,
        connected: 1040,
        outcome: 'observed',
        documentVisible: false
      })
    )
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    f.render()
    f.timing?.finish('disposed')
    expect(record).toHaveBeenCalledOnce()
  })

  it('does not subscribe from arrival alone or claim a render on timeout', () => {
    const f = fixture()
    f.timing?.mark('liveData')
    f.timing?.mark('connected')
    expect(f.onRender).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(record.mock.calls[0][1]).toMatchObject({ outcome: 'timeout', liveData: 0 })
    expect(record.mock.calls[0][1]).not.toHaveProperty('renderEvent')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['subscribe', 'dispose'] as const)(
    'contains a %s failure without interrupting writes or cleanup',
    (failure) => {
      const f = fixture(true, failure)
      const write = f.timing?.firstWrite()
      expect(() => write?.beforeWrite()).not.toThrow()
      expect(() => f.timing?.finish('disposed')).not.toThrow()
      expect(record).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['disposed', 'replaced', 'error'] as const)(
    'cleans up %s and ignores late callbacks',
    (reason) => {
      const f = fixture()
      f.timing?.mark('liveData')
      const write = f.timing?.firstWrite()
      write?.beforeWrite()
      write?.beforeWrite()
      expect(f.onRender).toHaveBeenCalledOnce()
      expect(f.timing?.firstWrite()).toBeUndefined()
      f.retire()
      f.timing?.finish(reason)
      write?.onParsed()
      f.render()
      expect(record).toHaveBeenCalledOnce()
      expect(record.mock.calls[0][1]).not.toHaveProperty('parsed')
      expect(record.mock.calls[0][1].ptyId).toBe('pty-1')
      expect(f.dispose).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
