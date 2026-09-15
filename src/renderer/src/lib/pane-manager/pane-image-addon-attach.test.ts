import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { openTerminal } from './pane-lifecycle'
import { toPublicPane } from './pane-public-view'

const imageAddonMock = vi.hoisted(() => ({
  constructError: null as Error | null,
  loadError: null as Error | null,
  instances: [] as { dispose: ReturnType<typeof vi.fn> }[]
}))

vi.mock('@xterm/addon-image', () => ({
  ImageAddon: vi.fn().mockImplementation(function ImageAddon() {
    if (imageAddonMock.constructError) {
      throw imageAddonMock.constructError
    }
    const instance = { dispose: vi.fn() }
    imageAddonMock.instances.push(instance)
    return instance
  })
}))

function createOpenTerminalHarness(): { pane: ManagedPaneInternal; events: string[] } {
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

  vi.stubGlobal(
    'MutationObserver',
    vi.fn(function MutationObserver() {
      return { observe: vi.fn(), disconnect: vi.fn() }
    })
  )

  const terminal = {
    element: {
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      classList: { contains: vi.fn(() => false) }
    },
    textarea: null,
    cols: 80,
    rows: 24,
    open: vi.fn(() => {
      events.push('open')
    }),
    loadAddon: vi.fn((addon: object) => {
      if (imageAddonMock.instances.includes(addon as (typeof imageAddonMock.instances)[number])) {
        if (imageAddonMock.loadError) {
          throw imageAddonMock.loadError
        }
        events.push('loadAddon:image')
        return
      }
      if (addon === unicode11Addon) {
        events.push('loadAddon:unicode11')
      }
    }),
    attachCustomWheelEventHandler: vi.fn(),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    registerCharacterJoiner: vi.fn(),
    unicode: unicodeProxy,
    buffer: { active: { cursorX: 0, cursorY: 0 } }
  } as unknown as ManagedPaneInternal['terminal']

  const leafId = '33333333-3333-4333-8333-333333333333' as never
  const pane: ManagedPaneInternal = {
    id: 7,
    leafId,
    stablePaneId: leafId,
    terminal,
    container: { appendChild: vi.fn(), addEventListener: vi.fn() } as never,
    xtermContainer: {
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as never,
    linkTooltip: {} as never,
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
    imageAddon: null,
    webLinksAddon,
    webglAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }

  return { pane, events }
}

describe('openTerminal — image addon isolation', () => {
  beforeEach(() => {
    imageAddonMock.constructError = null
    imageAddonMock.loadError = null
    imageAddonMock.instances = []
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches the image addon and keeps opening the pane', () => {
    const { pane, events } = createOpenTerminalHarness()

    openTerminal(pane)

    expect(pane.imageAddon).toBe(imageAddonMock.instances[0])
    expect(toPublicPane(pane).hasImageSupport).toBe(true)
    expect(events).toContain('loadAddon:image')
    expect(events).toContain('activeVersion=11')
    expect(pane.arabicShapingJoinerCleanup).toBeTypeOf('function')
  })

  it('keeps opening the pane when ImageAddon construction throws', () => {
    imageAddonMock.constructError = new Error('image addon ctor failed')
    const { pane, events } = createOpenTerminalHarness()

    openTerminal(pane)

    expect(pane.imageAddon).toBeNull()
    expect(toPublicPane(pane).hasImageSupport).toBe(false)
    expect(imageAddonMock.instances).toHaveLength(0)
    expect(events).toContain('loadAddon:unicode11')
    expect(events).toContain('activeVersion=11')
    expect(pane.arabicShapingJoinerCleanup).toBeTypeOf('function')
    expect(console.warn).toHaveBeenCalledWith(
      '[terminal] image addon failed to attach for pane',
      pane.id,
      imageAddonMock.constructError
    )
  })

  it('disposes a constructed addon and keeps opening the pane when loadAddon throws', () => {
    imageAddonMock.loadError = new Error('image addon load failed')
    const { pane, events } = createOpenTerminalHarness()

    openTerminal(pane)

    expect(pane.imageAddon).toBeNull()
    expect(toPublicPane(pane).hasImageSupport).toBe(false)
    expect(imageAddonMock.instances).toHaveLength(1)
    expect(imageAddonMock.instances[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(events).not.toContain('loadAddon:image')
    expect(events).toContain('activeVersion=11')
    expect(pane.arabicShapingJoinerCleanup).toBeTypeOf('function')
    expect(console.warn).toHaveBeenCalledWith(
      '[terminal] image addon failed to attach for pane',
      pane.id,
      imageAddonMock.loadError
    )
  })
})
