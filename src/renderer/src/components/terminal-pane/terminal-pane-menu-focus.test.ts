import { describe, expect, it, vi } from 'vitest'
import { reclaimTerminalPaneFocus } from './terminal-pane-menu-focus'

describe('reclaimTerminalPaneFocus', () => {
  const syncScheduler = (cb: () => void) => cb()

  it('does nothing when pane is null or undefined', () => {
    expect(() => reclaimTerminalPaneFocus(null, { scheduleRefocus: syncScheduler })).not.toThrow()
    expect(() => reclaimTerminalPaneFocus(undefined, { scheduleRefocus: syncScheduler })).not.toThrow()
  })

  it('does not focus if container is not connected to the DOM', () => {
    const focusMock = vi.fn()
    const pane = {
      container: {
        isConnected: false,
        ownerDocument: { body: {}, activeElement: null },
        contains: vi.fn()
      } as unknown as HTMLElement,
      terminal: { focus: focusMock } as never
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).not.toHaveBeenCalled()
  })

  it('reclaims focus when activeElement is document.body', () => {
    const focusMock = vi.fn()
    const mockBody = {}
    const pane = {
      container: {
        isConnected: true,
        ownerDocument: { body: mockBody, activeElement: mockBody },
        contains: vi.fn().mockReturnValue(false)
      } as unknown as HTMLElement,
      terminal: { focus: focusMock } as never
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('reclaims focus when activeElement is null', () => {
    const focusMock = vi.fn()
    const mockBody = {}
    const pane = {
      container: {
        isConnected: true,
        ownerDocument: { body: mockBody, activeElement: null },
        contains: vi.fn().mockReturnValue(false)
      } as unknown as HTMLElement,
      terminal: { focus: focusMock } as never
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('reclaims focus when activeElement is inside the pane container', () => {
    const focusMock = vi.fn()
    const mockActive = {}
    const pane = {
      container: {
        isConnected: true,
        ownerDocument: { body: {}, activeElement: mockActive },
        contains: vi.fn().mockReturnValue(true)
      } as unknown as HTMLElement,
      terminal: { focus: focusMock } as never
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT steal focus when activeElement is another element outside the container', () => {
    const focusMock = vi.fn()
    const mockActive = {}
    const mockBody = {}
    const pane = {
      container: {
        isConnected: true,
        ownerDocument: { body: mockBody, activeElement: mockActive },
        contains: vi.fn().mockReturnValue(false)
      } as unknown as HTMLElement,
      terminal: { focus: focusMock } as never
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).not.toHaveBeenCalled()
  })
})
