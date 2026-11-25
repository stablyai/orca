import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import { registerLivePaneManager, unregisterLivePaneManager } from '../pane-manager-registry'
import {
  checkAtlasIntegrity,
  verifyPaneWebglAtlasIntegrity,
  type AtlasIntegrityDeps,
  type GlyphAtlasLike,
  type GlyphInkReader
} from './terminal-webgl-atlas-integrity'

const WHITE_ON_BLACK = { foreground: { rgba: 0xffffffff }, background: { rgba: 0x000000ff } }
const glyph = (x: number, y = 0) => ({ texturePosition: { x, y }, size: { x: 9, y: 18 } })
const EMPTY = { texturePosition: { x: 0, y: 0 }, size: { x: 0, y: 0 } }

function atlas(options: {
  pages?: GlyphAtlasLike['pages']
  cached?: Record<number, typeof EMPTY>
  colors?: typeof WHITE_ON_BLACK
}): GlyphAtlasLike {
  const cached = options.cached ?? {}
  return {
    pages: options.pages ?? [{ canvas: { width: 512, height: 512 }, glyphs: [glyph(0), glyph(9)] }],
    _cacheMap: { get: (code, bg, fg, ext) => (bg || fg || ext ? undefined : cached[code]) },
    _config: { colors: options.colors ?? WHITE_ON_BLACK }
  }
}

const ink: GlyphInkReader = () => true
const noInkAt =
  (blankX: number, blankY = 0): GlyphInkReader =>
  (_canvas, rect) =>
    !(rect.x === blankX && rect.y === blankY)

describe('checkAtlasIntegrity', () => {
  it('reports a healthy atlas as healthy', () => {
    expect(checkAtlasIntegrity(atlas({ cached: { 97: glyph(0) } }), ink)).toEqual({
      outcome: 'healthy'
    })
  })

  it('finds a packed glyph whose page pixels are gone', () => {
    expect(checkAtlasIntegrity(atlas({}), () => false)).toEqual({
      outcome: 'poisoned',
      finding: { reason: 'blank-page-glyph', page: 0, pageSize: 512 }
    })
  })

  it('samples every quadrant of a merged page', () => {
    const merged = atlas({
      pages: [
        {
          canvas: { width: 1024, height: 1024 },
          glyphs: [glyph(0), glyph(512), glyph(0, 512), glyph(512, 512)]
        }
      ]
    })
    expect(checkAtlasIntegrity(merged, noInkAt(512, 512))).toMatchObject({ outcome: 'poisoned' })
  })

  it('treats an atlas without packed glyphs as inconclusive even with an empty letter', () => {
    const emptyOnly = atlas({ pages: [{ canvas: { width: 512, height: 512 }, glyphs: [] }], cached: { 101: EMPTY } })
    expect(checkAtlasIntegrity(emptyOnly, ink)).toEqual({ outcome: 'inconclusive' })
  })

  it('finds a letter cached empty when it must have ink', () => {
    expect(checkAtlasIntegrity(atlas({ cached: { 101: EMPTY } }), ink)).toEqual({
      outcome: 'poisoned',
      finding: { reason: 'empty-cached-glyph', probe: 101 }
    })
  })

  it('accepts an empty letter when the theme draws text in the background colour', () => {
    const sameColour = { foreground: { rgba: 0x101010ff }, background: { rgba: 0x121212ff } }
    expect(checkAtlasIntegrity(atlas({ cached: { 101: EMPTY }, colors: sameColour }), ink)).toEqual(
      { outcome: 'healthy' }
    )
  })

  it('does not sample the oversized-glyph page or oversized rects', () => {
    const unsampled = atlas({
      pages: [
        { canvas: { width: 16384, height: 16384 }, glyphs: [glyph(0)] },
        { canvas: { width: 1024, height: 1024 }, glyphs: [{ texturePosition: { x: 0, y: 0 }, size: { x: 300, y: 18 } }] }
      ]
    })
    expect(checkAtlasIntegrity(unsampled, () => false)).toEqual({ outcome: 'inconclusive' })
  })

  it('treats a throwing or unreadable reader as inconclusive', () => {
    const throwing: GlyphInkReader = () => {
      throw new Error('readback failed')
    }
    expect(checkAtlasIntegrity(atlas({}), throwing)).toEqual({ outcome: 'inconclusive' })
    expect(checkAtlasIntegrity(atlas({}), () => null)).toEqual({ outcome: 'inconclusive' })
  })
})

type FakePane = ManagedPaneInternal & { refresh: ReturnType<typeof vi.fn> }

function fakePane(paneAtlas: GlyphAtlasLike | undefined, options: { synchronizedOutput?: boolean } = {}): FakePane {
  const refresh = vi.fn()
  const refreshRows = vi.fn()
  const terminal = {
    rows: 24,
    refresh,
    _core: options.synchronizedOutput
      ? {
          _renderService: { _isPaused: false, refreshRows },
          coreService: { decPrivateModes: { synchronizedOutput: true } }
        }
      : undefined
  }
  const container = { isConnected: true, querySelector: () => null }
  return {
    id: 1,
    terminal,
    container,
    refresh,
    refreshRows,
    webglDisabledAfterContextLoss: false,
    webglAddon: { clearTextureAtlas: vi.fn(), _renderer: { _charAtlas: paneAtlas } }
  } as unknown as FakePane
}

function manager(visible: boolean, panes: FakePane[]) {
  return {
    resetWebglTextureAtlases: () => {},
    isVisibleForAtlasRecovery: () => visible,
    forEachInternalPane: (visit: (pane: ManagedPaneInternal) => void) => panes.forEach(visit)
  }
}

let clock = 0
const managers: ReturnType<typeof manager>[] = []
let timers: { callback: () => void; ms: number }[] = []
const deps = (hasInk: GlyphInkReader): AtlasIntegrityDeps => ({
  now: () => clock,
  hasInk,
  setTimer: (callback, ms) => {
    timers.push({ callback, ms })
    return 0 as unknown as ReturnType<typeof setTimeout>
  }
})

function register(visible: boolean, panes: FakePane[]): void {
  const entry = manager(visible, panes)
  managers.push(entry)
  registerLivePaneManager(entry)
}

beforeEach(() => {
  // Module spacing state outlives a test, so every test starts far in the future.
  clock += 1_000_000
  timers = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  managers.splice(0).forEach(unregisterLivePaneManager)
  vi.restoreAllMocks()
})

describe('verifyPaneWebglAtlasIntegrity', () => {
  it('rebuilds only the poisoned atlas and repaints only its visible owners', () => {
    const poisoned = atlas({})
    const detecting = fakePane(poisoned)
    const sibling = fakePane(poisoned)
    const unrelated = fakePane(atlas({}))
    const hidden = fakePane(poisoned)
    register(true, [detecting, sibling, unrelated])
    register(false, [hidden])

    verifyPaneWebglAtlasIntegrity(detecting, 'reveal', deps(() => false))

    expect(detecting.webglAddon?.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(sibling.webglAddon?.clearTextureAtlas).not.toHaveBeenCalled()
    expect(sibling.refresh).toHaveBeenCalled()
    expect(unrelated.refresh).not.toHaveBeenCalled()
    expect(hidden.refresh).not.toHaveBeenCalled()
  })

  it('repaints through the synchronized-output present path instead of forcing a refresh', () => {
    const poisoned = atlas({})
    const pane = fakePane(poisoned, { synchronizedOutput: true })
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(() => false))

    expect(pane.refresh).not.toHaveBeenCalled()
    expect((pane as unknown as { refreshRows: ReturnType<typeof vi.fn> }).refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('caps recoveries of one atlas', () => {
    const poisoned = atlas({})
    const pane = fakePane(poisoned)
    register(true, [pane])
    for (let attempt = 0; attempt < 5; attempt++) {
      clock += 61_000
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(() => false))
    }
    expect(pane.webglAddon?.clearTextureAtlas).toHaveBeenCalledTimes(3)
  })

  it('lets an inconclusive attach check leave the reveal check free to run', () => {
    const paneAtlas = atlas({})
    const pane = fakePane(paneAtlas)
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(() => null))
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(() => false))

    expect(timers).toHaveLength(0)
    expect(pane.webglAddon?.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('defers a check inside the cooldown and runs it once at cooldown end', () => {
    const paneAtlas = atlas({})
    const pane = fakePane(paneAtlas)
    register(true, [pane])
    let inked = true
    const reader: GlyphInkReader = () => inked

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(reader))
    inked = false
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(reader))
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(reader))

    expect(timers).toHaveLength(1)
    expect(pane.webglAddon?.clearTextureAtlas).not.toHaveBeenCalled()
    clock += timers[0].ms
    timers[0].callback()
    expect(pane.webglAddon?.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('drops a deferred check once the pane no longer shows that atlas through the same renderer', () => {
    const paneAtlas = atlas({})
    const pane = fakePane(paneAtlas)
    register(true, [pane])
    let inked = true
    const reader: GlyphInkReader = () => inked

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(reader))
    inked = false
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(reader))
    const staleAddon = pane.webglAddon
    pane.webglAddon = { clearTextureAtlas: vi.fn(), _renderer: { _charAtlas: paneAtlas } } as never
    clock += timers[0].ms
    timers[0].callback()

    expect(staleAddon?.clearTextureAtlas).not.toHaveBeenCalled()
    expect(pane.webglAddon?.clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('never throws into its caller when atlas internals throw', () => {
    const throwingAtlas = atlas({})
    throwingAtlas._cacheMap = {
      get: () => {
        throw new Error('internals changed')
      }
    }
    const pane = fakePane(throwingAtlas)
    register(true, [pane])
    expect(() => verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))).not.toThrow()
  })
})
