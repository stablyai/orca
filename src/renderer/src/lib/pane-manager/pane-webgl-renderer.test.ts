import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  attachWebgl,
  resetTerminalWebglSuggestion,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'

function createPane(options: { loadAddon?: () => void } = {}): ManagedPaneInternal {
  const leafId = '22222222-2222-4222-8222-222222222222' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      loadAddon: vi.fn(options.loadAddon)
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingWebglRefreshRafId: null,
    fitAddon: {
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 23 })),
      fit: vi.fn()
    } as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('terminal WebGL addon lifecycle', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('disposes a live addon when attach bails instead of orphaning it', () => {
    const pane = createPane()
    attachWebgl(pane)
    const liveAddon = pane.webglAddon
    expect(liveAddon).not.toBeNull()
    const disposeSpy = vi.spyOn(liveAddon as WebglAddon, 'dispose')

    // An undisposed addon here kept painting stale frames while atlas resets,
    // reattach checks, and diagnostics all treated the pane as DOM-rendered.
    pane.webglAttachmentDeferred = true
    attachWebgl(pane)

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()
  })

  it('disposes the previous addon before attaching a replacement', () => {
    const pane = createPane()
    attachWebgl(pane)
    const firstAddon = pane.webglAddon
    expect(firstAddon).not.toBeNull()
    const disposeSpy = vi.spyOn(firstAddon as WebglAddon, 'dispose')

    attachWebgl(pane)

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).not.toBeNull()
    expect(pane.webglAddon).not.toBe(firstAddon)
  })

  it('disposes the constructed addon when loading it fails', () => {
    const disposeSpy = vi.spyOn(WebglAddon.prototype, 'dispose')
    const pane = createPane({
      loadAddon: () => {
        throw new Error('WebGL2 not supported null')
      }
    })

    attachWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('still refreshes the terminal when resetting a pane without a WebGL addon', () => {
    const pane = createPane()
    expect(pane.webglAddon).toBeNull()

    resetWebglTextureAtlas(pane)

    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('skips the reset while WebGL is latched off after a context loss', () => {
    const pane = createPane()
    pane.webglDisabledAfterContextLoss = true

    resetWebglTextureAtlas(pane)

    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })
})
