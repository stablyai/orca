import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

const mocks = vi.hoisted(() => ({
  refreshTerminalImeInputContext: vi.fn(),
  isInsideFocusOwnedPane: vi.fn(() => false)
}))

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', () => ({
  refreshTerminalImeInputContext: mocks.refreshTerminalImeInputContext
}))

vi.mock('@/lib/pane-manager/pane-pointer-focus', () => ({
  isInsideFocusOwnedPane: mocks.isInsideFocusOwnedPane
}))

// Why: `closest` is unused directly (isInsideFocusOwnedPane mock above stands
// in for the real .pane lookup) but kept so callers matching a `.closest`
// shape don't throw.
function fakeHelper(): { focus: ReturnType<typeof vi.fn>; closest: ReturnType<typeof vi.fn> } {
  return { focus: vi.fn(), closest: vi.fn(() => ({})) }
}

describe('focusTerminalTabSurface', () => {
  afterEach(() => {
    mocks.refreshTerminalImeInputContext.mockClear()
    mocks.isInsideFocusOwnedPane.mockReset().mockReturnValue(false)
    vi.unstubAllGlobals()
  })

  function flushAnimationFrames(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  }

  it('focuses the scoped xterm helper textarea', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea' ? textarea : null
      )
    })

    focusTerminalTabSurface('tab-1')

    expect(textarea.focus).toHaveBeenCalled()
  })

  it('optionally refreshes the focused helper native input context', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea' ? textarea : null
      )
    })

    focusTerminalTabSurface('tab-1', null, { refreshImeContext: true })

    expect(textarea.focus).toHaveBeenCalledOnce()
    expect(mocks.refreshTerminalImeInputContext).toHaveBeenCalledWith(textarea, {
      onRefocusSkipped: undefined
    })
  })

  it('does not steal focus from a newer owner during guarded remount recovery', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const textarea = fakeHelper()
    const body = {}
    const outside = {}
    const documentState = {
      activeElement: body as unknown,
      body,
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea' ? textarea : null
      )
    }
    vi.stubGlobal('document', documentState)

    focusTerminalTabSurface('tab-1', null, { onlyIfFocusUnclaimed: true })
    frames.shift()?.(0)
    documentState.activeElement = outside
    frames.shift()?.(0)

    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('does not steal focus onto a pane whose composer owns focus', () => {
    // Why: regression for the real-world miss — the composer overlay is a DOM
    // sibling of the xterm container (both children of .pane), not an
    // ancestor of the helper textarea, so this must check the shared .pane
    // container rather than helper.closest(marker) directly.
    flushAnimationFrames()
    mocks.isInsideFocusOwnedPane.mockReturnValue(true)
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea' ? textarea : null
      )
    })

    focusTerminalTabSurface('tab-1')

    expect(mocks.isInsideFocusOwnedPane).toHaveBeenCalledWith(textarea)
    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('does not steal focus while inline tab rename is open', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) => {
        if (selector === '[data-tab-rename-input="true"]') {
          return {}
        }
        return selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea'
          ? textarea
          : null
      })
    })

    focusTerminalTabSurface('tab-1')

    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('falls back to the single tab helper when an old leaf id was reminted', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"]' ? { getAttribute: () => 'new-leaf' } : null
      ),
      querySelectorAll: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea'
          ? { length: 1, item: () => textarea }
          : { length: 0, item: () => null }
      )
    })

    focusTerminalTabSurface('tab-1', 'stale-leaf')

    expect(textarea.focus).toHaveBeenCalled()
  })

  it('does not focus a mounted sibling while a requested split leaf is still expected', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"]'
          ? { getAttribute: () => 'mounted-leaf pending-leaf' }
          : null
      ),
      querySelectorAll: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea'
          ? { length: 1, item: () => textarea }
          : { length: 0, item: () => null }
      )
    })

    focusTerminalTabSurface('tab-1', 'pending-leaf')

    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('does not use stale-leaf fallback while the expected layout still has multiple leaves', () => {
    flushAnimationFrames()
    const textarea = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"]'
          ? { getAttribute: () => 'mounted-leaf pending-leaf' }
          : null
      ),
      querySelectorAll: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea'
          ? { length: 1, item: () => textarea }
          : { length: 0, item: () => null }
      )
    })

    focusTerminalTabSurface('tab-1', 'stale-leaf')

    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('does not focus a sibling when a stale leaf id has multiple helpers in the tab', () => {
    flushAnimationFrames()
    const first = fakeHelper()
    const second = fakeHelper()
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"]'
          ? { getAttribute: () => 'new-left new-right' }
          : null
      ),
      querySelectorAll: vi.fn((selector: string) =>
        selector === '[data-terminal-tab-id="tab-1"] .xterm-helper-textarea'
          ? { length: 2, item: (index: number) => (index === 0 ? first : second) }
          : { length: 0, item: () => null }
      )
    })

    focusTerminalTabSurface('tab-1', 'stale-leaf')

    expect(first.focus).not.toHaveBeenCalled()
    expect(second.focus).not.toHaveBeenCalled()
  })

  it('cancels a pending focus frame when a newer focus request starts', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 9)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null)
    })

    focusTerminalTabSurface('tab-1')
    focusTerminalTabSurface('tab-2')

    expect(cancelAnimationFrame).toHaveBeenCalledWith(9)
  })
})
