import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  primeTerminalWebglAddon,
  resetTerminalWebglSuggestion
} from './pane-webgl-renderer'
import { openTerminal, setLigaturesEnabled } from './pane-lifecycle'
import {
  buildDefaultTerminalOptions,
  resolveTerminalScrollOnUserInput
} from './pane-terminal-options'

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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stand-in for xterm's Terminal exposing only the members these lifecycle paths touch.
    terminal: {
      loadAddon: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
      refresh: vi.fn(),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      cols: 80,
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
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 23 }))
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    ligaturesAddon: null,
    webLinksAddon: {} as never,
    webglAddon: null,
    imageAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('attachWebgl', () => {
  beforeEach(async () => {
    await primeTerminalWebglAddon()
    webglMock.contextLossHandler = null
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
  } {
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

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hand-built stand-in for xterm's Terminal; openTerminal touches only the members defined here, and a real Terminal needs a rendering canvas this suite has no DOM for.
    const terminal = {
      element: fakeTerminalElement,
      textarea: null,
      cols: 80,
      rows: 24,
      open: vi.fn(),
      loadAddon: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      refresh: vi.fn(),
      write: vi.fn(),
      registerCharacterJoiner: vi.fn(() => 3),
      deregisterCharacterJoiner: vi.fn(),
      clearSelection: vi.fn(),
      dispose: vi.fn(),
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
      imageAddon: null,
      compositionHandler: null,
      pendingSplitScrollState: null,
      debugLabel: null
    }

    return { pane }
  }

  it('builds one initial WebGL atlas with ligatures and still rebuilds on a live toggle', async () => {
    await primeTerminalWebglAddon()
    resetTerminalWebglSuggestion()
    vi.mocked(WebglAddon).mockClear()
    webglMock.dispose.mockClear()
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    const { pane } = createOpenTerminalHarness()
    pane.terminalGpuAcceleration = 'auto'
    pane.gpuRenderingEnabled = true

    openTerminal(pane, { ligatures: true })
    expect(pane.ligaturesAddon).not.toBeNull()
    expect(pane.webglAddon).not.toBeNull()
    const addons = vi.mocked(pane.terminal.loadAddon).mock.calls.map(([addon]) => addon)
    expect(addons.indexOf(pane.ligaturesAddon!)).toBeLessThan(addons.indexOf(pane.webglAddon!))
    setLigaturesEnabled(pane, true)
    expect(WebglAddon).toHaveBeenCalledTimes(1)
    expect(webglMock.dispose).not.toHaveBeenCalled()

    setLigaturesEnabled(pane, false)
    expect(WebglAddon).toHaveBeenCalledTimes(2)
    expect(webglMock.dispose).toHaveBeenCalledTimes(1)
    expect(pane.ligaturesAddon).toBeNull()
  })
})

describe('terminal scroll on user input', () => {
  it('scrolls to the bottom on input by default', () => {
    expect(buildDefaultTerminalOptions().scrollOnUserInput).toBe(true)
    expect(resolveTerminalScrollOnUserInput(undefined)).toBe(true)
    expect(resolveTerminalScrollOnUserInput(true)).toBe(true)
    expect(resolveTerminalScrollOnUserInput(false)).toBe(false)
  })
})
