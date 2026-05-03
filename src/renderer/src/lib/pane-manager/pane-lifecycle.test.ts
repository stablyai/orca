import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import { attachWebgl, resetTerminalWebglSuggestion } from './pane-lifecycle'
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
    terminalGpuAcceleration: 'auto',
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
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('buildDefaultTerminalOptions', () => {
  it('leaves macOS Option available for keyboard layout characters', () => {
    expect(buildDefaultTerminalOptions().macOptionIsMeta).toBe(false)
  })

  it('advertises kitty keyboard protocol so CLIs enable enhanced key reporting', () => {
    // Why: Orca already writes CSI-u bytes for extended key chords like
    // Shift+Enter (see terminal-shortcut-policy.ts). CLIs that gate
    // enhanced input on a CSI ? u handshake only read those bytes once the
    // terminal advertises support. Regressing this flag silently breaks
    // Shift+Enter (and other extended chords) in apps like Claude Code and
    // Codex, especially when running inside tmux.
    expect(buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard).toBe(true)
  })
})

describe('attachWebgl', () => {
  beforeEach(() => {
    webglMock.contextLossHandler = null
    webglMock.dispose.mockClear()
    vi.mocked(WebglAddon).mockClear()
    resetTerminalWebglSuggestion()
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
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)

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

  it('does not attach WebGL when terminal GPU acceleration is off', () => {
    const pane = createPane()
    pane.terminalGpuAcceleration = 'off'

    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('uses DOM for later auto panes after WebGL attach fails until the suggestion resets', () => {
    const firstPane = createPane()
    vi.mocked(WebglAddon).mockImplementationOnce(() => {
      throw new Error('webgl unavailable')
    })

    attachWebgl(firstPane)

    expect(firstPane.webglAddon).toBeNull()

    const laterAutoPane = createPane()
    attachWebgl(laterAutoPane)

    expect(laterAutoPane.terminal.loadAddon).not.toHaveBeenCalled()

    resetTerminalWebglSuggestion()
    const retriedAutoPane = createPane()
    attachWebgl(retriedAutoPane)

    expect(retriedAutoPane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('still attempts WebGL in on mode after auto mode suggests DOM', () => {
    const autoPane = createPane()
    vi.mocked(WebglAddon).mockImplementationOnce(() => {
      throw new Error('webgl unavailable')
    })

    attachWebgl(autoPane)

    const forcedPane = createPane()
    forcedPane.terminalGpuAcceleration = 'on'
    attachWebgl(forcedPane)

    expect(forcedPane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })
})
