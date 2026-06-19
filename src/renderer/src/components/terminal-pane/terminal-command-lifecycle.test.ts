import { describe, expect, it, vi } from 'vitest'
import { createTerminalCommandLifecycle } from './terminal-command-lifecycle'

describe('createTerminalCommandLifecycle', () => {
  it('emits commandFinished for OSC 133 D with best-effort exit codes', () => {
    const onCommandFinished = vi.fn()
    const lifecycle = createTerminalCommandLifecycle({ onCommandFinished })

    lifecycle.handlePtyData('before\x1b]133;A\x07prompt\x1b]133;B\x07')
    lifecycle.handlePtyData('\x1b]133;C\x07running\x1b]133;D;0\x07')
    lifecycle.handlePtyData('\x1b]133;D;130\x07')
    lifecycle.handlePtyData('\x1b]133;D;not-a-number\x07')
    lifecycle.handlePtyData('\x1b]133;D\x07')

    expect(onCommandFinished).toHaveBeenCalledTimes(4)
    expect(onCommandFinished).toHaveBeenNthCalledWith(1, 0)
    expect(onCommandFinished).toHaveBeenNthCalledWith(2, 130)
    expect(onCommandFinished).toHaveBeenNthCalledWith(3, null)
    expect(onCommandFinished).toHaveBeenNthCalledWith(4, null)
  })

  it('detects OSC 133 sequences split across PTY chunks', () => {
    const onCommandFinished = vi.fn()
    const lifecycle = createTerminalCommandLifecycle({ onCommandFinished })

    lifecycle.handlePtyData('chunk\x1b]133')
    lifecycle.handlePtyData(';D;42')
    lifecycle.handlePtyData('\x07next')

    expect(onCommandFinished).toHaveBeenCalledOnce()
    expect(onCommandFinished).toHaveBeenCalledWith(42)
  })

  it('carries partial OSC 133 prefixes after normal output', () => {
    const onCommandFinished = vi.fn()
    const lifecycle = createTerminalCommandLifecycle({ onCommandFinished })

    lifecycle.handlePtyData('output\x1b]')
    lifecycle.handlePtyData('133;D;0\x07')

    expect(onCommandFinished).toHaveBeenCalledOnce()
    expect(onCommandFinished).toHaveBeenCalledWith(0)
  })

  it('supports ESC backslash string terminators', () => {
    const onCommandFinished = vi.fn()
    const lifecycle = createTerminalCommandLifecycle({ onCommandFinished })

    lifecycle.handlePtyData('\x1b]133;D;7\x1b\\')

    expect(onCommandFinished).toHaveBeenCalledWith(7)
  })

  it('registers an xterm OSC consumer without emitting lifecycle events', () => {
    const onCommandFinished = vi.fn()
    const dispose = vi.fn()
    const registerOscHandler = vi.fn((_code: number, _handler: (payload: string) => boolean) => ({
      dispose
    }))
    const lifecycle = createTerminalCommandLifecycle({ onCommandFinished })

    const disposable = lifecycle.attachXtermConsumer({
      parser: { registerOscHandler }
    } as never)

    expect(registerOscHandler).toHaveBeenCalledWith(133, expect.any(Function))
    const handler = registerOscHandler.mock.calls[0][1]
    expect(handler('D;0')).toBe(true)
    expect(onCommandFinished).not.toHaveBeenCalled()

    disposable.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
