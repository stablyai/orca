import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import { registerLivePaneManager, unregisterLivePaneManager } from '../pane-manager-registry'
import { setTerminalWebglDiagnosticRecorder } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import {
  checkAtlasIntegrity,
  readGlyphInk,
  requestAtlasChangeIntegrityCheck,
  verifyPaneWebglAtlasIntegrity,
  type AtlasIntegrityDeps,
  type GlyphAtlasLike,
  type GlyphInkReader
} from './terminal-webgl-atlas-integrity'

type Glyph = NonNullable<GlyphAtlasLike['pages'][number]['glyphs']>[number]

// offset.y <= 1: xterm's top scan found ink, so the packed rect holds ink.
const glyph = (x: number, y = 0, offsetY = -3): Glyph => ({
  texturePosition: { x, y },
  size: { x: 9, y: 18 },
  offset: { x: -1, y: offsetY }
})

type MutableAtlas = { pages: { canvas: { width: number; height: number }; glyphs: Glyph[] }[] }

function atlas(glyphs: Glyph[] = [glyph(0), glyph(9)], width = 512): MutableAtlas {
  return { pages: [{ canvas: { width, height: width }, glyphs }] }
}

const all = { startPage: 0, round: 0, maxReads: 16 }
const ink: GlyphInkReader = () => 'ink'
const blank: GlyphInkReader = () => 'blank'

describe('checkAtlasIntegrity', () => {
  it('reports healthy when admitted rects read inked', () => {
    expect(checkAtlasIntegrity(atlas(), ink, all)).toMatchObject({ outcome: 'healthy', reads: 1 })
  })

  it('finds an admitted rect that lost its pixels', () => {
    expect(checkAtlasIntegrity(atlas(), blank, all)).toEqual({
      outcome: 'poisoned',
      finding: { reason: 'blank-page-glyph', page: 0, pageSize: 512 },
      reads: 1
    })
  })

  it('ignores rects whose ink may lie outside the crop, oversized or out of bounds', () => {
    const unproven = atlas([
      glyph(0, 0, 2),
      { ...glyph(0), size: { x: 300, y: 18 } },
      glyph(508),
      { ...glyph(0), texturePosition: { x: 0.5, y: 0 } }
    ])
    expect(checkAtlasIntegrity(unproven, blank, all)).toEqual({ outcome: 'inconclusive', reads: 0 })
  })

  it('samples each quadrant of a merged page and rotates through neighbours', () => {
    const merged = atlas([glyph(0), glyph(9), glyph(512), glyph(0, 512), glyph(512, 512)], 1024)
    const blankAt = (x: number, y: number): GlyphInkReader => (_c, rect) =>
      rect.x === x && rect.y === y ? 'blank' : 'ink'
    expect(checkAtlasIntegrity(merged, blankAt(512, 512), all)).toMatchObject({ outcome: 'poisoned' })
    expect(checkAtlasIntegrity(merged, blankAt(9, 0), all)).toMatchObject({ outcome: 'healthy' })
    expect(checkAtlasIntegrity(merged, blankAt(9, 0), { ...all, round: 1 })).toMatchObject({
      outcome: 'poisoned'
    })
  })

  it('counts unreadable and throwing reads against the budget without calling them poison', () => {
    const throwing: GlyphInkReader = () => {
      throw new Error('readback failed')
    }
    expect(checkAtlasIntegrity(atlas(), () => 'unreadable', all)).toEqual({
      outcome: 'inconclusive',
      reads: 1
    })
    expect(checkAtlasIntegrity(atlas(), throwing, all)).toEqual({ outcome: 'inconclusive', reads: 1 })
    expect(checkAtlasIntegrity(atlas(), blank, { ...all, maxReads: 0 })).toMatchObject({ reads: 0 })
  })
})

describe('readGlyphInk', () => {
  it('reports a scratch that silently returns transparent pixels as unreadable, not blank', () => {
    const transparent = {
      getContextAttributes: () => ({ alpha: true }),
      isContextLost: () => false,
      save() {},
      restore() {},
      clearRect() {},
      fillRect() {},
      drawImage() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4)
      }),
      globalCompositeOperation: 'source-over',
      fillStyle: ''
    }
    const element = { width: 0, height: 0, getContext: () => transparent }
    vi.stubGlobal('document', { createElement: () => element })
    try {
      expect(readGlyphInk({ width: 512, height: 512 }, { x: 0, y: 0, width: 9, height: 18 })).toBe(
        'unreadable'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

type FakePane = ManagedPaneInternal & {
  refresh: ReturnType<typeof vi.fn>
  refreshRows: ReturnType<typeof vi.fn>
  addon: { clearTextureAtlas: ReturnType<typeof vi.fn> }
}

function fakePane(
  paneAtlas: MutableAtlas,
  options: { synchronizedOutput?: boolean; covered?: boolean } = {}
): FakePane {
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
  const container = { isConnected: true, querySelector: () => (options.covered ? {} : null) }
  const addon = {
    _renderer: { _charAtlas: paneAtlas, _gl: { isContextLost: () => false } },
    clearTextureAtlas: vi.fn(() => {
      // xterm's eviction: one fresh page with no packed glyphs.
      paneAtlas.pages = [{ canvas: { width: 512, height: 512 }, glyphs: [] }]
    })
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

let clock = 0
let session = { resets: 0 }
let timers: { callback: () => void; ms: number }[] = []
const registered: object[] = []
const events: Record<string, unknown>[] = []

function deps(read: GlyphInkReader): AtlasIntegrityDeps {
  return {
    now: () => clock,
    read,
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    session
  }
}

function register(visible: boolean, panes: FakePane[]): void {
  const manager = {
    resetWebglTextureAtlases: () => {},
    isVisibleForAtlasRecovery: () => visible,
    containsElement: (element: Element) => panes.some((pane) => pane.container === element),
    forEachInternalPane: (visit: (pane: ManagedPaneInternal) => void) => panes.forEach(visit)
  }
  registered.push(manager)
  registerLivePaneManager(manager)
}

function runTimers(): void {
  const due = timers
  timers = []
  for (const timer of due) {
    clock += timer.ms
    timer.callback()
  }
}

beforeEach(() => {
  // Renderer-wide spacing and read budget outlive a test, so each test starts far later.
  clock += 10_000_000
  timers = []
  session = { resets: 0 }
  events.length = 0
  setTerminalWebglDiagnosticRecorder((kind, detail) => events.push({ kind, ...detail }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  registered.splice(0).forEach((manager) => unregisterLivePaneManager(manager as never))
  setTerminalWebglDiagnosticRecorder(null)
  vi.restoreAllMocks()
})

describe('verifyPaneWebglAtlasIntegrity', () => {
  it('evicts only the affected atlas and repaints only its eligible visible owners', () => {
    const poisoned = atlas()
    const detecting = fakePane(poisoned)
    const sibling = fakePane(poisoned)
    const coveredLeaf = fakePane(poisoned, { covered: true })
    const unrelated = fakePane(atlas())
    const hiddenOwner = fakePane(poisoned)
    register(true, [detecting, sibling, coveredLeaf, unrelated])
    register(false, [hiddenOwner])

    verifyPaneWebglAtlasIntegrity(detecting, 'reveal', deps(blank))

    expect(detecting.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(sibling.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(sibling.refresh).toHaveBeenCalled()
    expect(coveredLeaf.refresh).not.toHaveBeenCalled()
    expect(unrelated.refresh).not.toHaveBeenCalled()
    expect(hiddenOwner.refresh).not.toHaveBeenCalled()
    expect(events).toEqual([
      expect.objectContaining({ kind: 'webgl-atlas-poisoned', outcome: 'reset', trigger: 'reveal' })
    ])
  })

  it('records reset-failed when the clear does not evict, and keeps repainting other owners', () => {
    const poisoned = atlas()
    const detecting = fakePane(poisoned)
    detecting.addon.clearTextureAtlas.mockImplementation(() => {})
    const sibling = fakePane(poisoned)
    sibling.refresh.mockImplementation(() => {
      throw new Error('disposed')
    })
    register(true, [detecting, sibling])

    expect(() => verifyPaneWebglAtlasIntegrity(detecting, 'reveal', deps(blank))).not.toThrow()
    expect(events[0]).toMatchObject({ outcome: 'reset-failed' })
    expect(detecting.refresh).toHaveBeenCalled()
  })

  it('keeps DEC 2026 frames coherent by repainting through the synchronized-output path', () => {
    const pane = fakePane(atlas(), { synchronizedOutput: true })
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(pane.refresh).not.toHaveBeenCalled()
    expect(pane.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('refuses resets past the per-atlas cap', () => {
    const pane = fakePane(atlas())
    register(true, [pane])
    for (let attempt = 0; attempt < 5; attempt++) {
      clock += 61_000
      pane.addon.clearTextureAtlas.mockImplementation(() => {})
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    }
    expect(pane.addon.clearTextureAtlas).toHaveBeenCalledTimes(3)
    expect(events.map((event) => event.outcome)).toEqual([
      'reset-failed',
      'reset-failed',
      'reset-failed',
      'refused',
      'refused'
    ])
  })

  it('lets a zero-read attach leave the following reveal free to check', () => {
    const paneAtlas = atlas([])
    const pane = fakePane(paneAtlas)
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(blank))
    paneAtlas.pages[0].glyphs.push(glyph(0))
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(timers).toHaveLength(0)
    expect(pane.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('starts the cooldown after an unreadable attempt and defers the next request once', () => {
    const pane = fakePane(atlas())
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(() => 'unreadable'))
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(timers).toHaveLength(1)
    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    runTimers()
    expect(pane.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(events[0]).toMatchObject({ trigger: 'deferred' })
  })

  it('hands a deferred check to another eligible owner when the requester is covered', () => {
    const shared = atlas()
    const first = fakePane(shared)
    const second = fakePane(shared)
    register(true, [first, second])

    verifyPaneWebglAtlasIntegrity(first, 'attach', deps(ink))
    clock += 100
    verifyPaneWebglAtlasIntegrity(second, 'reveal', deps(blank))
    ;(second.container as unknown as { querySelector: () => object }).querySelector = () => ({})
    runTimers()

    expect(first.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('retires a deferred check when no eligible owner of the atlas remains', () => {
    const shared = atlas()
    const pane = fakePane(shared)
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))
    clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    pane.webglAddon = { ...pane.addon, _renderer: { _charAtlas: atlas() } } as never
    runTimers()

    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
  })

  it('runs the atlas-change check on a later task, after xterm installs the atlas', () => {
    const paneAtlas = atlas()
    const pane = fakePane(paneAtlas)
    register(true, [pane])
    const later = deps(blank)

    requestAtlasChangeIntegrityCheck(pane, later)
    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    runTimers()
    expect(events[0]).toMatchObject({ trigger: 'atlas-change', outcome: 'reset' })
  })

  it('never throws into its caller when atlas internals throw', () => {
    const throwing = atlas()
    Object.defineProperty(throwing.pages[0], 'glyphs', {
      get: () => {
        throw new Error('internals changed')
      }
    })
    const pane = fakePane(throwing)
    register(true, [pane])
    expect(() => verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))).not.toThrow()
  })
})
