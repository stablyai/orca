import { describe, expect, it, vi } from 'vitest'
import { openWindowsConsoleInput, WINDOWS_CONSOLE_INPUT_DEVICE } from './windows-console-input'

describe('openWindowsConsoleInput', () => {
  it('opens CONIN$ read-write and disposes the fd once', () => {
    const openSync = vi.fn(() => 11)
    const closeSync = vi.fn()
    const opened = openWindowsConsoleInput({ platform: 'win32', openSync, closeSync })
    expect(opened).not.toBe('inherit')
    if (opened === 'inherit') {
      return
    }
    expect(openSync).toHaveBeenCalledWith(WINDOWS_CONSOLE_INPUT_DEVICE, 'r+')
    expect(opened.fd).toBe(11)
    opened.dispose()
    opened.dispose()
    expect(closeSync).toHaveBeenCalledOnce()
    expect(closeSync).toHaveBeenCalledWith(11)
  })
})
