import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl } from './pane-lifecycle'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

const webglMock = vi.hoisted(() => ({
  contextLossHandler: null as (() => void) | null,
  dispose: vi.fn()
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(function WebglAddon() {
    return {
      onContextLoss: vi.fn((handler: () => void) => {
        webglMock.contextLossHandler = handler
      }),
      dispose: webglMock.dispose
    }
  })
}))

function createPane(): ManagedPaneInternal {
  return {
    id: 1,
    terminal: {
      loadAddon: vi.fn(),
      refresh: vi.fn(),
      rows: 24
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    fitAddon: {
      fit: vi.fn()
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    ligaturesAddon: null,
    webLinksAddon: {} as never,
    webglAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null
  }
}

describe('buildDefaultTerminalOptions', () => {
  it('leaves macOS Option available for keyboard layout characters', () => {
    expect(buildDefaultTerminalOptions().macOptionIsMeta).toBe(false)
  })
})

describe('attachWebgl', () => {
  beforeEach(() => {
    webglMock.contextLossHandler = null
    webglMock.dispose.mockClear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a pane on the DOM renderer after WebGL context loss', () => {
    const pane = createPane()

    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(webglMock.contextLossHandler).not.toBeNull()

    webglMock.contextLossHandler?.()

    expect(pane.webglAddon).toBeNull()
    expect(pane.webglDisabledAfterContextLoss).toBe(true)

    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('does not attach WebGL while initial rendering is deferred', () => {
    const pane = createPane()
    pane.webglAttachmentDeferred = true

    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
  })
})
