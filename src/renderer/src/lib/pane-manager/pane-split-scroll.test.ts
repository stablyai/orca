import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'

const restoreScrollState = vi.hoisted(() => vi.fn())

vi.mock('./pane-scroll', () => ({
  restoreScrollState
}))

import { scheduleSplitScrollRestore } from './pane-split-scroll'

const scrollState = {
  bufferType: 'normal',
  wasAtBottom: true,
  firstVisibleLineContent: '',
  viewportY: 0,
  totalLines: 24
} satisfies ScrollState

const alternateScrollState = {
  ...scrollState,
  bufferType: 'alternate'
} satisfies ScrollState

function createPane(bufferType: 'normal' | 'alternate'): {
  pane: ManagedPaneInternal
  bufferChangeDisposable: { dispose: ReturnType<typeof vi.fn> }
  triggerBufferChange: (bufferType: 'normal' | 'alternate') => void
} {
  let bufferChangeHandler: ((buffer: { type: 'normal' | 'alternate' }) => void) | null = null
  const bufferChangeDisposable = { dispose: vi.fn() }
  const pane: ManagedPaneInternal = {
    id: 1,
    terminal: {
      rows: 24,
      refresh: vi.fn(),
      buffer: {
        active: {
          type: bufferType,
          length: 24
        },
        onBufferChange: vi.fn((handler: (buffer: { type: 'normal' | 'alternate' }) => void) => {
          bufferChangeHandler = handler
          return bufferChangeDisposable
        })
      }
    } as never,
    container: {
      querySelectorAll: vi.fn(() => [])
    } as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    fitAddon: {} as never,
    searchAddon: {} as never,
    serializeAddon: {
      serialize: vi.fn(() => '')
    } as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: scrollState,
    debugLabel: null
  }
  return {
    pane,
    bufferChangeDisposable,
    triggerBufferChange: (bufferType) => bufferChangeHandler?.({ type: bufferType })
  }
}

describe('scheduleSplitScrollRestore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    restoreScrollState.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('restores and refreshes normal-screen panes after split reparenting settles', () => {
    const { pane } = createPane('normal')
    const reattachWebgl = vi.fn()

    scheduleSplitScrollRestore(
      () => pane,
      pane.id,
      scrollState,
      () => false,
      reattachWebgl
    )

    expect(restoreScrollState).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)

    vi.advanceTimersByTime(200)

    expect(pane.pendingSplitScrollState).toBeNull()
    expect(reattachWebgl).toHaveBeenCalledWith(pane)
    expect(restoreScrollState).toHaveBeenCalledTimes(2)
    expect(pane.terminal.refresh).toHaveBeenCalledTimes(2)
  })

  it('defers WebGL reattach and skips scroll restore for alternate-screen panes', () => {
    const { pane, bufferChangeDisposable, triggerBufferChange } = createPane('alternate')
    const reattachWebgl = vi.fn()

    scheduleSplitScrollRestore(
      () => pane,
      pane.id,
      alternateScrollState,
      () => false,
      reattachWebgl
    )

    expect(restoreScrollState).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
    expect(pane.pendingSplitScrollState).toBe(scrollState)

    vi.advanceTimersByTime(200)

    expect(pane.pendingSplitScrollState).toBeNull()
    expect(reattachWebgl).not.toHaveBeenCalled()
    expect(restoreScrollState).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()

    triggerBufferChange('alternate')

    expect(reattachWebgl).not.toHaveBeenCalled()
    expect(bufferChangeDisposable.dispose).not.toHaveBeenCalled()

    triggerBufferChange('normal')

    expect(bufferChangeDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(reattachWebgl).toHaveBeenCalledWith(pane)
    expect(restoreScrollState).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('defers normal-screen scroll restore until an active TUI exits alternate screen', () => {
    const { pane, triggerBufferChange } = createPane('alternate')
    const reattachWebgl = vi.fn()

    scheduleSplitScrollRestore(
      () => pane,
      pane.id,
      scrollState,
      () => false,
      reattachWebgl
    )

    vi.advanceTimersByTime(200)

    expect(pane.pendingSplitScrollState).toBe(scrollState)
    expect(restoreScrollState).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()

    triggerBufferChange('normal')

    expect(pane.pendingSplitScrollState).toBeNull()
    expect(reattachWebgl).toHaveBeenCalledWith(pane)
    expect(restoreScrollState).toHaveBeenCalledWith(pane.terminal, scrollState)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })
})
