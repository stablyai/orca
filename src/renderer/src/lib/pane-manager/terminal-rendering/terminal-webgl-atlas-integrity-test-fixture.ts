import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import {
  registerLivePaneManager,
  unregisterLivePaneManager,
  type RegisteredPaneManager
} from '../pane-manager-registry'
import { setTerminalWebglDiagnosticRecorder } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import {
  createAtlasIntegrityState,
  type AtlasIntegrityDeps
} from './terminal-webgl-atlas-integrity'
import type {
  AtlasCanvas,
  GlyphAtlasLike,
  GlyphInkReader,
  GlyphRect,
  InkRead
} from './terminal-webgl-atlas-sampling'

type Glyph = NonNullable<GlyphAtlasLike['pages'][number]['glyphs']>[number]
type Page = { canvas: { width: number; height: number }; glyphs: Glyph[] }
type MutableAtlas = { pages: Page[]; pageLayoutVersion: number }

// offset.y = padding - top + adj; -3 means xterm's top scan found ink at row 7 with padding 4.
export const glyph = (x: number, y = 0, offsetY = -3): Glyph => ({
  texturePosition: { x, y },
  size: { x: 9, y: 18 },
  offset: { x: -1, y: offsetY }
})

export function atlas(glyphs: Glyph[] = [glyph(0), glyph(9)], width = 512): MutableAtlas {
  return { pages: [{ canvas: { width, height: width }, glyphs }], pageLayoutVersion: 1 }
}

export const ink = fakeReader(() => 'ink')
export const blank = fakeReader(() => 'blank')

export function fakeReader(
  classify: (canvas: AtlasCanvas, rect: GlyphRect) => InkRead
): GlyphInkReader {
  return (canvas, rect, onReadIssued) => {
    const result = classify(canvas, rect)
    if (result !== 'unavailable') {
      onReadIssued()
    }
    return result
  }
}

type FakePane = ManagedPaneInternal & {
  webglAddon: NonNullable<ManagedPaneInternal['webglAddon']>
  refresh: ReturnType<typeof vi.fn>
  refreshRows: ReturnType<typeof vi.fn>
  addon: {
    _renderer: { _charAtlas: MutableAtlas }
    clearTextureAtlas: ReturnType<typeof vi.fn>
  }
}

export function evict(paneAtlas: MutableAtlas): void {
  paneAtlas.pageLayoutVersion++
  paneAtlas.pages = [{ canvas: { width: 512, height: 512 }, glyphs: [] }]
}

export function fakePane(
  paneAtlas: MutableAtlas,
  options: { synchronizedOutput?: boolean; covered?: boolean; contextLost?: boolean } = {}
): FakePane {
  const refresh = vi.fn()
  const refreshRows = vi.fn()
  const terminal = {
    rows: 24,
    refresh,
    element: { isConnected: true },
    _core: options.synchronizedOutput
      ? {
          _renderService: { _isPaused: false, refreshRows },
          coreService: { decPrivateModes: { synchronizedOutput: true } }
        }
      : undefined
  }
  const container = { isConnected: true, querySelector: () => (options.covered ? {} : null) }
  const renderer = {
    _charAtlas: paneAtlas,
    _gl: { isContextLost: () => options.contextLost === true }
  }
  const addon = {
    _renderer: renderer,
    clearTextureAtlas: vi.fn(() => evict(renderer._charAtlas))
  }
  return {
    id: 1,
    terminal,
    container,
    refresh,
    refreshRows,
    addon,
    webglDisabledAfterContextLoss: false,
    webglAddon: addon
  } as unknown as FakePane
}

export function setupAtlasIntegrityFixture() {
  const fixture = {
    clock: 0,
    timers: [] as { callback: () => void; ms: number }[],
    windowPresented: true,
    state: createAtlasIntegrityState(),
    events: [] as Record<string, unknown>[],
    deps(read: GlyphInkReader): AtlasIntegrityDeps {
      return {
        now: () => fixture.clock,
        read,
        setTimer: (callback, ms) => fixture.timers.push({ callback, ms }),
        isWindowPresented: () => fixture.windowPresented,
        state: fixture.state
      }
    }
  }
  const registered: RegisteredPaneManager[] = []

  function register(visible: boolean, panes: ManagedPaneInternal[]) {
    const manager = {
      resetWebglTextureAtlases: () => {},
      isVisibleForAtlasRecovery: () => visible,
      containsElement: (element: Element) => panes.some((pane) => pane.container === element),
      forEachInternalPane: (visit: (pane: ManagedPaneInternal) => boolean | void) =>
        panes.some((pane) => visit(pane) === true)
    }
    registered.push(manager)
    registerLivePaneManager(manager)
    return manager
  }

  function runTimers(): void {
    for (let round = 0; round < 10 && fixture.timers.length; round++) {
      const due = fixture.timers.splice(0)
      for (const timer of due) {
        fixture.clock += timer.ms
        timer.callback()
      }
    }
  }

  function takeScheduledWake(delay: number): () => void {
    expect(fixture.timers).toEqual([{ callback: expect.any(Function), ms: delay }])
    expect(fixture.state.timerArmed).toBe(true)
    const [{ callback }] = fixture.timers.splice(0, 1)
    return callback
  }

  function advanceServiceClock(ms: number): void {
    fixture.clock += ms
    vi.setSystemTime(Date.now() + ms)
  }

  beforeEach(() => {
    fixture.clock = 1_000_000
    fixture.timers.length = 0
    fixture.windowPresented = true
    fixture.events.length = 0
    fixture.state = createAtlasIntegrityState()
    setTerminalWebglDiagnosticRecorder((kind, detail) => fixture.events.push({ kind, ...detail }))
  })

  afterEach(() => {
    registered.splice(0).forEach(unregisterLivePaneManager)
    setTerminalWebglDiagnosticRecorder(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  return Object.assign(fixture, { register, runTimers, takeScheduledWake, advanceServiceClock })
}
