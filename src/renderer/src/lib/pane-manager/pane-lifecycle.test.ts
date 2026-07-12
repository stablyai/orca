import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  markComplexScriptOutput,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { attachLigatures, disposePane, openTerminal } from './pane-lifecycle'
import { ensureArabicShapingJoinerForText } from './terminal-arabic-shaping-joiner'
import {
  buildDefaultTerminalOptions,
  DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY,
  DEFAULT_TERMINAL_SCROLL_SENSITIVITY,
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from './pane-terminal-options'
import { buildTerminalKeyboardProtocolOptions } from './terminal-keyboard-protocol'

const webglMock = vi.hoisted(() => ({
  contextLossHandler: null as (() => void) | null,
  clearTextureAtlas: vi.fn(),
  dispose: vi.fn()
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(function WebglAddon() {
    return {
      onContextLoss: vi.fn((handler: () => void) => {
        webglMock.contextLossHandler = handler
      }),
      clearTextureAtlas: webglMock.clearTextureAtlas,
      dispose: webglMock.dispose
    }
  })
}))

function createPane(): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      loadAddon: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
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

  it('uses the default inactive outline only for the block cursor', () => {
    expect(buildDefaultTerminalOptions().cursorStyle).toBe('block')
    expect(buildDefaultTerminalOptions().cursorInactiveStyle).toBe('outline')
  })

  it('shows the slim xterm scrollbar in its reserved gutter', () => {
    // Why: 7px gutter is an accepted ~1-column cost (VS Code reserves 14);
    // the v1.4.51 table corruption that once forced width 0 was the ZWJ
    // width bug, fixed separately by the Orca unicode provider.
    expect(buildDefaultTerminalOptions().scrollbar?.width).toBe(7)
  })

  it('uses the shared desktop scrollback row default', () => {
    expect(buildDefaultTerminalOptions().scrollback).toBe(5_000)
  })

  it('slightly increases default terminal wheel scrolling while preserving fast scroll', () => {
    const options = buildDefaultTerminalOptions()

    expect(options.scrollSensitivity).toBe(DEFAULT_TERMINAL_SCROLL_SENSITIVITY)
    expect(options.fastScrollSensitivity).toBe(DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY)
  })

  it('normalizes configurable terminal scroll sensitivity values', () => {
    expect(normalizeTerminalScrollSensitivity(undefined)).toBe(DEFAULT_TERMINAL_SCROLL_SENSITIVITY)
    expect(normalizeTerminalScrollSensitivity(0)).toBe(0.1)
    expect(normalizeTerminalScrollSensitivity(20)).toBe(10)
    expect(normalizeTerminalFastScrollSensitivity(undefined)).toBe(
      DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY
    )
    expect(normalizeTerminalFastScrollSensitivity(0)).toBe(1)
    expect(normalizeTerminalFastScrollSensitivity(25)).toBe(20)
  })

  it('enables xterm contrast correction for low-contrast CLI colors', () => {
    expect(buildDefaultTerminalOptions().minimumContrastRatio).toBe(4.5)
  })

  it('only uses inactive outline for block cursors', () => {
    expect(resolveTerminalCursorInactiveStyle('block')).toBe('outline')
    expect(resolveTerminalCursorInactiveStyle('bar')).toBe('bar')
    expect(resolveTerminalCursorInactiveStyle('underline')).toBe('underline')
  })

  it('advertises kitty keyboard protocol so CLIs enable enhanced key reporting', () => {
    // Why: Orca already writes CSI-u bytes for extended key chords like
    // Shift+Enter on non-Windows platforms (see terminal-shortcut-policy.ts).
    // CLIs that gate enhanced input on a CSI ? u handshake only read those
    // bytes once the terminal advertises support. Regressing this flag
    // silently breaks enhanced chords, especially inside tmux.
    expect(buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard).toBe(true)
  })

  it('lets a local Windows ConPTY pane override the default and withhold kitty keyboard', () => {
    // Regression for #2434: per-pane options merge over the default the same way
    // createPaneDOM merges them, so a local Windows ConPTY override must win and
    // turn the advertised kittyKeyboard off (CSI-u-blind local CLIs ignore nav keys).
    const merged = {
      ...buildDefaultTerminalOptions(),
      ...buildTerminalKeyboardProtocolOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe',
        executionHostId: 'local'
      })
    }

    expect(merged.vtExtensions?.kittyKeyboard).toBe(false)
  })

  it('keeps kitty keyboard when a local Windows ConPTY pane is launching Grok', () => {
    // Why: Grok needs KKP for Ctrl+Enter interject / Shift+Enter newline; the
    // ConPTY withhold must not win when launchAgent (or tuiAgent) is grok.
    const merged = {
      ...buildDefaultTerminalOptions(),
      ...buildTerminalKeyboardProtocolOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe',
        executionHostId: 'local',
        tuiAgent: 'grok'
      })
    }

    expect(merged.vtExtensions?.kittyKeyboard).toBe(true)
  })

  it('keeps the advertised kitty keyboard default for SSH and macOS/Linux panes', () => {
    for (const context of [
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      },
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null,
        executionHostId: 'local'
      }
    ] as const) {
      const merged = {
        ...buildDefaultTerminalOptions(),
        ...buildTerminalKeyboardProtocolOptions(context)
      }

      expect(merged.vtExtensions?.kittyKeyboard).toBe(true)
    }
  })
})

describe('attachWebgl', () => {
  beforeEach(() => {
    webglMock.contextLossHandler = null
    webglMock.clearTextureAtlas.mockClear()
    webglMock.dispose.mockClear()
    vi.mocked(WebglAddon).mockClear()
    resetTerminalWebglSuggestion()
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
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
    pane.terminalGpuAcceleration = 'on'

    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(webglMock.contextLossHandler).not.toBeNull()
    vi.mocked(pane.terminal.refresh).mockClear()

    webglMock.contextLossHandler?.()

    expect(pane.webglAddon).toBeNull()
    expect(pane.webglDisabledAfterContextLoss).toBe(true)
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)

    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('repaints the current buffer after WebGL attaches', () => {
    const pane = createPane()
    pane.terminalGpuAcceleration = 'on'

    attachWebgl(pane)

    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('clears the WebGL texture atlas and refreshes the buffer on recovery', async () => {
    const { resetWebglTextureAtlas } = await import('./pane-webgl-renderer')
    const pane = createPane()
    pane.terminalGpuAcceleration = 'on'

    attachWebgl(pane)
    vi.mocked(pane.terminal.refresh).mockClear()
    resetWebglTextureAtlas(pane)

    expect(webglMock.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('does not reset a WebGL atlas after context-loss fallback', async () => {
    const { resetWebglTextureAtlas } = await import('./pane-webgl-renderer')
    const pane = createPane()
    pane.terminalGpuAcceleration = 'on'

    attachWebgl(pane)
    webglMock.contextLossHandler?.()
    vi.mocked(pane.terminal.refresh).mockClear()
    webglMock.clearTextureAtlas.mockClear()
    resetWebglTextureAtlas(pane)

    expect(webglMock.clearTextureAtlas).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('does not attach WebGL while initial rendering is deferred', () => {
    const pane = createPane()
    pane.terminalGpuAcceleration = 'on'
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

  it('uses WebGL rendering for auto GPU acceleration on non-Linux platforms', () => {
    const pane = createPane()

    attachWebgl(pane)

    expect(pane.webglAddon).not.toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('uses DOM rendering for auto GPU acceleration on Linux', () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })
    const pane = createPane()

    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(pane.terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('uses WebGL rendering for Linux auto GPU acceleration on hardware renderers', () => {
    const rendererKey = 0x9246
    const vendorKey = 0x9245
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })
    vi.stubGlobal('document', {
      createElement: vi.fn((tagName: string) => {
        if (tagName !== 'canvas') {
          return {}
        }
        return {
          getContext: vi.fn((contextName: string) =>
            contextName === 'webgl2'
              ? {
                  getExtension: vi.fn(() => ({
                    UNMASKED_RENDERER_WEBGL: rendererKey,
                    UNMASKED_VENDOR_WEBGL: vendorKey
                  })),
                  getParameter: vi.fn((key: number) =>
                    key === rendererKey
                      ? 'Mesa Intel(R) UHD Graphics 770'
                      : key === vendorKey
                        ? 'Intel'
                        : null
                  )
                }
              : null
          )
        }
      })
    })
    resetTerminalWebglSuggestion()
    const pane = createPane()

    attachWebgl(pane)

    expect(pane.webglAddon).not.toBeNull()
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('still allows forced WebGL on Linux', () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
    })
    const pane = createPane()
    pane.terminalGpuAcceleration = 'on'

    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('keeps auto-mode panes on WebGL after complex-script output', () => {
    const pane = createPane()

    attachWebgl(pane)
    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    vi.mocked(pane.terminal.loadAddon).mockClear()

    markComplexScriptOutput(pane)

    expect(pane.hasComplexScriptOutput).toBe(true)
    expect(pane.webglAddon).not.toBeNull()
    expect(webglMock.dispose).not.toHaveBeenCalled()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('keeps later auto panes on DOM after WebGL attach fails', () => {
    vi.mocked(WebglAddon).mockImplementationOnce(() => {
      throw new Error('webgl unavailable')
    })
    const firstPane = createPane()
    const secondPane = createPane()

    attachWebgl(firstPane)
    attachWebgl(secondPane)

    expect(firstPane.webglAddon).toBeNull()
    expect(secondPane.webglAddon).toBeNull()
    expect(secondPane.terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('keeps forced WebGL on after complex-script output', () => {
    const pane = createPane()

    markComplexScriptOutput(pane)
    pane.terminalGpuAcceleration = 'on'
    attachWebgl(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
  })
})

describe('attachLigatures', () => {
  it('refreshes existing rows after loading the ligatures addon', () => {
    const pane = createPane()

    attachLigatures(pane)

    expect(pane.terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(pane.ligaturesAddon).not.toBeNull()
  })
})

describe('openTerminal — addon and provider wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function createOpenTerminalHarness(): {
    pane: ManagedPaneInternal
    events: string[]
    getRegisteredJoinHandler: () => ((text: string) => [number, number][]) | null
  } {
    const events: string[] = []
    let registeredJoinHandler: ((text: string) => [number, number][]) | null = null

    const fitAddon = {
      fit: vi.fn()
    } as unknown as ManagedPaneInternal['fitAddon']
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

    const fakePaneContainer = {
      appendChild: vi.fn(),
      addEventListener: vi.fn()
    } as unknown as HTMLDivElement
    const fakeXtermContainer = {
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as HTMLDivElement
    const fakeTooltip = {} as unknown as HTMLDivElement
    const fakeTerminalElement = {
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      classList: { contains: vi.fn(() => false) }
    } as unknown as HTMLElement
    vi.stubGlobal(
      'MutationObserver',
      vi.fn(function MutationObserver() {
        return { observe: vi.fn(), disconnect: vi.fn() }
      })
    )

    const terminal = {
      element: fakeTerminalElement,
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
      attachCustomWheelEventHandler: vi.fn(),
      write: vi.fn(() => {
        events.push('write')
      }),
      registerCharacterJoiner: vi.fn((handler: (text: string) => [number, number][]) => {
        events.push('registerCharacterJoiner')
        registeredJoinHandler = handler
        return 3
      }),
      deregisterCharacterJoiner: vi.fn((joinerId: number) => {
        events.push(`deregisterCharacterJoiner:${joinerId}`)
      }),
      unicode: unicodeProxy,
      buffer: { active: { cursorX: 0, cursorY: 0 } }
    } as unknown as ManagedPaneInternal['terminal']

    const leafId = '22222222-2222-4222-8222-222222222222' as never
    const pane: ManagedPaneInternal = {
      id: 1,
      leafId,
      stablePaneId: leafId,
      terminal,
      container: fakePaneContainer,
      xtermContainer: fakeXtermContainer,
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

    return { pane, events, getRegisteredJoinHandler: () => registeredJoinHandler }
  }

  // Why: CJK / emoji / ZWJ widths get baked into the buffer at the active
  // unicode version on write. If anything writes bytes through xterm before
  // unicode v11 is activated (still on default v6 width tables), wide chars
  // lay out as single cells. The bug surfaces as the broken `?`-style glyphs
  // users saw on worktree switch.
  it('activates unicode 11 before any caller-driven write would be possible', () => {
    const { pane, events } = createOpenTerminalHarness()

    openTerminal(pane)

    expect(pane.container.appendChild).toHaveBeenCalledWith(pane.linkTooltip)
    expect(pane.xtermContainer.appendChild).not.toHaveBeenCalled()
    expect(pane.terminal.element!.appendChild).not.toHaveBeenCalled()
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

  // Why: ordinary panes must avoid xterm's full-grid character-joiner scan,
  // while the first RTL write still registers before xterm parses the text.
  it('registers Arabic shaping lazily and deregisters it on dispose', () => {
    const { pane, events } = createOpenTerminalHarness()

    openTerminal(pane)

    expect(events).not.toContain('registerCharacterJoiner')
    expect(pane.arabicShapingJoinerCleanup).toBeTypeOf('function')
    ensureArabicShapingJoinerForText(pane.terminal, 'مرحبا')
    expect(events).toContain('registerCharacterJoiner')

    disposePane(pane, new Map([[pane.id, pane]]))

    expect(events).toContain('deregisterCharacterJoiner:3')
    expect(pane.arabicShapingJoinerCleanup).toBeNull()
  })

  // Why: the DOM renderer misrenders joined spans (per-character
  // letter-spacing blowout), so the joiner must only join while this pane's
  // WebGL addon is live — locked here against the real openTerminal wiring.
  it('joins RTL runs only while the pane has a live WebGL addon', () => {
    const { pane, getRegisteredJoinHandler } = createOpenTerminalHarness()

    openTerminal(pane)
    ensureArabicShapingJoinerForText(pane.terminal, 'مرحبا')
    const handler = getRegisteredJoinHandler()!

    expect(pane.webglAddon).toBeNull()
    expect(handler('مرحبا')).toEqual([])

    pane.webglAddon = {} as never
    expect(handler('مرحبا')).toEqual([[0, 5]])

    pane.webglAddon = null
    expect(handler('مرحبا')).toEqual([])
  })
})
