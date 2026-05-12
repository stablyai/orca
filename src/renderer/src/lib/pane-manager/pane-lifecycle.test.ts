import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  markComplexScriptOutput,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { openTerminal } from './pane-lifecycle'
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
    hasComplexScriptOutput: false,
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

  it('keeps auto-mode panes on DOM after complex-script output', () => {
    const pane = createPane()

    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)

    markComplexScriptOutput(pane)

    expect(pane.hasComplexScriptOutput).toBe(true)
    expect(pane.webglAddon).toBeNull()
    expect(webglMock.dispose).toHaveBeenCalledTimes(1)

    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('allows explicit on mode to override complex-script DOM fallback', () => {
    const pane = createPane()

    markComplexScriptOutput(pane)
    pane.terminalGpuAcceleration = 'on'
    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })
})

describe('openTerminal — Unicode 11 ordering', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Why: CJK / emoji / ZWJ widths get baked into the buffer at the active
  // unicode version on write. If anything writes bytes through xterm before
  // unicode v11 is activated (still on default v6 width tables), wide chars
  // lay out as single cells. The bug surfaces as the broken `?`-style glyphs
  // users saw on worktree switch.
  it('activates unicode 11 before any caller-driven write would be possible', () => {
    const events: string[] = []

    const fitAddon = { fit: vi.fn() } as unknown as ManagedPaneInternal['fitAddon']
    const searchAddon = {} as unknown as ManagedPaneInternal['searchAddon']
    const serializeAddon = {} as unknown as ManagedPaneInternal['serializeAddon']
    const unicode11Addon = {} as unknown as ManagedPaneInternal['unicode11Addon']
    const webLinksAddon = {} as unknown as ManagedPaneInternal['webLinksAddon']

    const unicodeProxy = {
      _version: '6' as '6' | '11',
      get activeVersion(): '6' | '11' {
        return this._version
      },
      set activeVersion(v: '6' | '11') {
        events.push(`activeVersion=${v}`)
        this._version = v
      }
    }

    const fakeContainer = {
      appendChild: vi.fn(),
      addEventListener: vi.fn()
    } as unknown as HTMLDivElement
    const fakeTooltip = {} as unknown as HTMLDivElement

    const terminal = {
      element: null as HTMLElement | null,
      textarea: null,
      cols: 80,
      rows: 24,
      open: vi.fn(() => {
        events.push('open')
      }),
      loadAddon: vi.fn((addon: object) => {
        if (addon === fitAddon) {
          events.push('loadAddon:fit')
        } else if (addon === searchAddon) {
          events.push('loadAddon:search')
        } else if (addon === serializeAddon) {
          events.push('loadAddon:serialize')
        } else if (addon === unicode11Addon) {
          events.push('loadAddon:unicode11')
        } else if (addon === webLinksAddon) {
          events.push('loadAddon:webLinks')
        }
      }),
      write: vi.fn(() => {
        events.push('write')
      }),
      unicode: unicodeProxy,
      buffer: { active: { cursorX: 0, cursorY: 0 } }
    } as unknown as ManagedPaneInternal['terminal']

    const pane: ManagedPaneInternal = {
      id: 1,
      terminal,
      container: fakeContainer,
      xtermContainer: fakeContainer,
      linkTooltip: fakeTooltip,
      terminalGpuAcceleration: 'off',
      gpuRenderingEnabled: false,
      webglAttachmentDeferred: false,
      webglDisabledAfterContextLoss: false,
      hasComplexScriptOutput: false,
      fitAddon,
      fitResizeObserver: null,
      pendingObservedFitRafId: null,
      searchAddon,
      serializeAddon,
      unicode11Addon,
      ligaturesAddon: null,
      webLinksAddon,
      webglAddon: null,
      compositionHandler: null,
      pendingSplitScrollState: null,
      debugLabel: null
    }

    openTerminal(pane)

    expect(events).toContain('loadAddon:unicode11')
    expect(events).toContain('activeVersion=11')

    const unicodeIdx = events.indexOf('activeVersion=11')
    const writeIdx = events.indexOf('write')
    if (writeIdx !== -1) {
      expect(unicodeIdx).toBeLessThan(writeIdx)
    }

    const loadUnicodeIdx = events.indexOf('loadAddon:unicode11')
    expect(loadUnicodeIdx).toBeLessThan(unicodeIdx)
    expect(events.indexOf('open')).toBeLessThan(loadUnicodeIdx)
  })
})
