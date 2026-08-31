import { describe, expect, it, vi } from 'vitest'
import {
  openWindowsConsoleInput,
  stdioForWindowsInteractiveChild,
  WINDOWS_CONSOLE_INPUT_DEVICE
} from './windows-console-input'

describe('openWindowsConsoleInput', () => {
  it('returns inherit off Windows without opening the device', () => {
    const openSync = vi.fn()
    expect(openWindowsConsoleInput({ platform: 'darwin', openSync })).toBe('inherit')
    expect(openWindowsConsoleInput({ platform: 'linux', openSync })).toBe('inherit')
    expect(openSync).not.toHaveBeenCalled()
  })

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

  it('returns inherit when the console device cannot be opened', () => {
    const openSync = vi.fn(() => {
      throw new Error('no console')
    })
    expect(openWindowsConsoleInput({ platform: 'win32', openSync })).toBe('inherit')
  })
})

describe('stdioForWindowsInteractiveChild', () => {
  it('keeps JSON stdout on the CLI envelope stream', () => {
    const { stdio, dispose } = stdioForWindowsInteractiveChild(true, {
      platform: 'win32',
      openSync: vi.fn(() => 11),
      closeSync: vi.fn()
    })
    expect(stdio).toEqual([11, process.stderr, 'inherit'])
    dispose()
  })

  it('preserves inherited output outside JSON mode', () => {
    const { stdio, dispose } = stdioForWindowsInteractiveChild(false, {
      platform: 'win32',
      openSync: vi.fn(() => 11),
      closeSync: vi.fn()
    })
    expect(stdio).toEqual([11, 'inherit', 'inherit'])
    dispose()
  })
})
