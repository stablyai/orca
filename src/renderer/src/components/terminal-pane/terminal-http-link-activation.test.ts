import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTerminalHttpLinkActivation', () => {
  it('leaves Alt+Cmd gestures to the child TUI on macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })

    expect(
      isTerminalHttpLinkActivation({ metaKey: true, ctrlKey: false, altKey: false } as MouseEvent)
    ).toBe(true)
    expect(
      isTerminalHttpLinkActivation({ metaKey: true, ctrlKey: false, altKey: true } as MouseEvent)
    ).toBe(false)
  })

  it('leaves Alt+Ctrl gestures to the child TUI on other platforms', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    expect(
      isTerminalHttpLinkActivation({ metaKey: false, ctrlKey: true, altKey: false } as MouseEvent)
    ).toBe(true)
    expect(
      isTerminalHttpLinkActivation({ metaKey: false, ctrlKey: true, altKey: true } as MouseEvent)
    ).toBe(false)
  })
})
