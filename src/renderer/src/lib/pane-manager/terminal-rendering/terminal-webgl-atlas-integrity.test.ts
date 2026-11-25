import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '../pane-manager-types'
import { registerLivePaneManager, unregisterLivePaneManager } from '../pane-manager-registry'
import { setTerminalWebglDiagnosticRecorder } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import {
  createAtlasIntegrityState,
  requestAtlasChangeIntegrityCheck,
  verifyPaneWebglAtlasIntegrity,
  type AtlasIntegrityDeps
} from './terminal-webgl-atlas-integrity'
import { createGlyphInkReader } from './terminal-webgl-atlas-ink-reader'
import {
  admittedRect,
  checkAtlasIntegrity,
  type GlyphAtlasLike,
  type GlyphInkReader
} from './terminal-webgl-atlas-sampling'

type Glyph = NonNullable<GlyphAtlasLike['pages'][number]['glyphs']>[number]
type Page = { canvas: { width: number; height: number }; glyphs: Glyph[] }
type MutableAtlas = { pages: Page[]; pageLayoutVersion: number }

// offset.y = padding - top + adj; -3 means xterm's top scan found ink at row 7 with padding 4.
const glyph = (x: number, y = 0, offsetY = -3): Glyph => ({
  texturePosition: { x, y },
  size: { x: 9, y: 18 },
  offset: { x: -1, y: offsetY }
})

function atlas(glyphs: Glyph[] = [glyph(0), glyph(9)], width = 512): MutableAtlas {
  return { pages: [{ canvas: { width, height: width }, glyphs }], pageLayoutVersion: 1 }
}

const traversal = () => ({ layoutVersion: undefined, cursors: [], startPage: 0 })
const ink: GlyphInkReader = () => 'ink'
const blank: GlyphInkReader = () => 'blank'

describe('admittedRect', () => {
  const page = { width: 512, height: 512 }
  it('admits only glyphs whose top scan provably found ink', () => {
    expect(admittedRect(glyph(0), page)).not.toBeNull()
    // Restricted glyphs use padding 0: a missed top scan gives offset.y 0 (or more with adjustment).
    expect(admittedRect(glyph(0, 0, 0), page)).toBeNull()
    expect(admittedRect(glyph(0, 0, 4), page)).toBeNull()
  })

  it('rejects oversized, fractional and out-of-page rects', () => {
    expect(admittedRect({ ...glyph(0), size: { x: 300, y: 18 } }, page)).toBeNull()
    expect(admittedRect({ ...glyph(0), texturePosition: { x: 0.5, y: 0 } }, page)).toBeNull()
    expect(admittedRect(glyph(508), page)).toBeNull()
  })
})

describe('checkAtlasIntegrity', () => {
  it('reports healthy only when every read in the observed set had ink', () => {
    expect(checkAtlasIntegrity(atlas(), ink, traversal(), 16)).toEqual({
      outcome: 'healthy',
      reads: 1
    })
    const mixed: GlyphInkReader = (canvas) => (canvas.width === 512 ? 'ink' : 'unreadable')
    const twoPages = atlas()
    twoPages.pages.push({ canvas: { width: 1024, height: 1024 }, glyphs: [glyph(0)] })
    expect(checkAtlasIntegrity(twoPages, mixed, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 2
    })
  })

  it('reads every admitted glyph of a page in turn, one per attempt', () => {
    const merged = atlas([glyph(0), glyph(9), glyph(512), glyph(0, 512), glyph(512, 512)], 1024)
    const blankLast: GlyphInkReader = (_c, rect) =>
      rect.x === 512 && rect.y === 512 ? 'blank' : 'ink'
    const walk = traversal()
    const outcomes = Array.from(
      { length: 5 },
      () => checkAtlasIntegrity(merged, blankLast, walk, 16).outcome
    )
    expect(outcomes).toEqual(['healthy', 'healthy', 'healthy', 'healthy', 'poisoned'])
  })

  it('finds an admitted rect that lost its pixels', () => {
    expect(checkAtlasIntegrity(atlas(), blank, traversal(), 16)).toEqual({
      outcome: 'poisoned',
      finding: { reason: 'blank-page-glyph', page: 0, pageSize: 512 },
      reads: 1
    })
  })

  it('walks past a long unadmitted prefix across attempts', () => {
    const prefix = Array.from({ length: 64 }, (_, i) => glyph(i, 0, 1))
    const page = atlas([...prefix, glyph(0, 100)])
    const walk = traversal()
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toEqual({
      outcome: 'inconclusive',
      reads: 0
    })
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toMatchObject({ outcome: 'poisoned' })
  })

  it('restarts its walk when the atlas layout changes', () => {
    const page = atlas([glyph(0, 0, 1), glyph(0, 100)])
    const walk = { layoutVersion: 1, cursors: [1], startPage: 0 }
    page.pageLayoutVersion = 2
    page.pages[0].glyphs = [glyph(0, 200)]
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toMatchObject({ outcome: 'poisoned' })
  })

  it('counts unreadable and throwing reads and respects the read budget', () => {
    const throwing: GlyphInkReader = () => {
      throw new Error('readback failed')
    }
    expect(checkAtlasIntegrity(atlas(), throwing, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 1
    })
    expect(checkAtlasIntegrity(atlas(), blank, traversal(), 0)).toEqual({
      outcome: 'inconclusive',
      reads: 0
    })
  })
})

/** Alpha-only 2D context: enough of the canvas model for the reader's copy and control pixels. */
function fakeKit(options: { dropControls?: boolean; lost?: boolean } = {}) {
  const width = 258
  const alpha = new Uint8ClampedArray(width * 256)
  const ctx = {
    fillStyle: '',
    getContextAttributes: () => ({ alpha: true }),
    isContextLost: () => options.lost === true,
    clearRect: (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row++) {
        alpha.fill(0, row * width + x, row * width + x + w)
      }
    },
    fillRect: (x: number, y: number) => {
      if (!options.dropControls) {
        alpha[y * width + x] = 255
      }
    },
    drawImage: (source: { alphaAt?: (x: number, y: number) => number }, ...args: number[]) => {
      if (args.length === 2) {
        if (!options.dropControls) {
          alpha[args[1] * width + args[0]] = 255
        }
        return
      }
      const [sx, sy, sw, sh, dx, dy] = args
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          alpha[(dy + y) * width + dx + x] = source.alphaAt?.(sx + x, sy + y) ?? 0
        }
      }
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          data[(y * w + x) * 4 + 3] = alpha[y * width + x]
        }
      }
      return { data }
    }
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, control: {} as HTMLCanvasElement }
}

const pageWithInk = (inked: boolean) => ({
  width: 512,
  height: 512,
  alphaAt: (x: number, y: number) => (inked && x === 3 && y === 0 ? 255 : 0)
})

describe('createGlyphInkReader', () => {
  it('classifies a genuinely blank rect as blank, including a one-pixel-high rect', () => {
    const read = createGlyphInkReader(() => fakeKit())
    expect(read(pageWithInk(false), { x: 0, y: 0, width: 9, height: 18 })).toBe('blank')
    expect(read(pageWithInk(false), { x: 0, y: 0, width: 9, height: 1 })).toBe('blank')
    expect(read(pageWithInk(true), { x: 0, y: 0, width: 9, height: 1 })).toBe('ink')
  })

  it('reports a scratch that silently loses pixels as unreadable, never blank', () => {
    expect(
      createGlyphInkReader(() => fakeKit({ dropControls: true }))(pageWithInk(false), {
        x: 0,
        y: 0,
        width: 9,
        height: 18
      })
    ).toBe('unreadable')
    expect(
      createGlyphInkReader(() => fakeKit({ lost: true }))(pageWithInk(false), {
        x: 0,
        y: 0,
        width: 9,
        height: 18
      })
    ).toBe('unreadable')
  })

  it('never credits ink from an invalid read', () => {
    const read = createGlyphInkReader(() => fakeKit({ dropControls: true }))
    expect(read(pageWithInk(true), { x: 0, y: 0, width: 9, height: 18 })).toBe('unreadable')
  })

  it('recreates a failed scratch once and then succeeds', () => {
    const kits = [fakeKit({ dropControls: true }), fakeKit()]
    const make = vi.fn(() => kits.shift() ?? null)
    const read = createGlyphInkReader(make)
    expect(read(pageWithInk(false), { x: 0, y: 0, width: 9, height: 18 })).toBe('blank')
    expect(make).toHaveBeenCalledTimes(2)
  })
})

type FakePane = ManagedPaneInternal & {
  refresh: ReturnType<typeof vi.fn>
  refreshRows: ReturnType<typeof vi.fn>
  addon: { clearTextureAtlas: ReturnType<typeof vi.fn> }
}

function evict(paneAtlas: MutableAtlas): void {
  paneAtlas.pageLayoutVersion++
  paneAtlas.pages = [{ canvas: { width: 512, height: 512 }, glyphs: [] }]
}

function fakePane(
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
  const addon = {
    _renderer: {
      _charAtlas: paneAtlas,
      _gl: { isContextLost: () => options.contextLost === true }
    },
    clearTextureAtlas: vi.fn(() => evict(paneAtlas))
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
let timers: { callback: () => void; ms: number }[] = []
let windowPresented = true
let deps: (read: GlyphInkReader) => AtlasIntegrityDeps
let state = createAtlasIntegrityState()
const registered: object[] = []
const events: Record<string, unknown>[] = []

function atlasOfPaneFor(pane: FakePane): unknown {
  return (pane.addon as unknown as { _renderer: { _charAtlas: unknown } })._renderer._charAtlas
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
  for (let round = 0; round < 10 && timers.length; round++) {
    const due = timers
    timers = []
    for (const timer of due) {
      clock += timer.ms
      timer.callback()
    }
  }
}

beforeEach(() => {
  clock = 1_000_000
  timers = []
  windowPresented = true
  events.length = 0
  state = createAtlasIntegrityState()
  deps = (read) => ({
    now: () => clock,
    read,
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    isWindowPresented: () => windowPresented,
    state
  })
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
    const lostContext = fakePane(poisoned, { contextLost: true })
    const unrelated = fakePane(atlas())
    const hiddenOwner = fakePane(poisoned)
    register(true, [detecting, sibling, coveredLeaf, lostContext, unrelated])
    register(false, [hiddenOwner])

    verifyPaneWebglAtlasIntegrity(detecting, 'reveal', deps(blank))

    expect(detecting.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(sibling.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(sibling.refresh).toHaveBeenCalled()
    for (const skipped of [coveredLeaf, lostContext, unrelated, hiddenOwner]) {
      expect(skipped.refresh).not.toHaveBeenCalled()
    }
    expect(events).toEqual([
      expect.objectContaining({ kind: 'webgl-atlas-poisoned', outcome: 'reset', trigger: 'reveal' })
    ])
  })

  it('reads the clear outcome before presenting, so a repainting owner cannot change it', () => {
    const poisoned = atlas()
    const pane = fakePane(poisoned)
    pane.refresh.mockImplementation(() => poisoned.pages[0].glyphs.push(glyph(0)))
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(events[0]).toMatchObject({ outcome: 'reset' })
  })

  it('records reset-failed for a throwing or incomplete clear and still hands owners to redraw', () => {
    const poisoned = atlas()
    const pane = fakePane(poisoned)
    pane.addon.clearTextureAtlas.mockImplementation(() => {
      poisoned.pageLayoutVersion++
      poisoned.pages = []
      throw new Error('page allocation failed')
    })
    const sibling = fakePane(poisoned)
    sibling.refresh.mockImplementation(() => {
      throw new Error('disposed')
    })
    register(true, [sibling, pane])

    expect(() => verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))).not.toThrow()
    expect(events[0]).toMatchObject({ outcome: 'reset-failed' })
    expect(pane.refresh).toHaveBeenCalled()
  })

  it('keeps a coherent DEC 2026 frame by presenting through the synchronized-output path', () => {
    const pane = fakePane(atlas(), { synchronizedOutput: true })
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(pane.refresh).not.toHaveBeenCalled()
    expect(pane.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('refuses resets past the per-atlas cap and charges failed clears', () => {
    const pane = fakePane(atlas())
    pane.addon.clearTextureAtlas.mockImplementation(() => {})
    register(true, [pane])
    for (let attempt = 0; attempt < 5; attempt++) {
      clock += 61_000
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

  it('does nothing while the window is parked or hidden', () => {
    const pane = fakePane(atlas())
    register(true, [pane])
    windowPresented = false

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
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

  it('serves deferred requests from one renderer-wide timer', () => {
    const first = atlas()
    const second = atlas()
    const firstPane = fakePane(first)
    const secondPane = fakePane(second)
    register(true, [firstPane, secondPane])

    verifyPaneWebglAtlasIntegrity(firstPane, 'attach', deps(ink))
    verifyPaneWebglAtlasIntegrity(secondPane, 'attach', deps(blank))
    verifyPaneWebglAtlasIntegrity(secondPane, 'reveal', deps(blank))

    expect(timers).toHaveLength(1)
    runTimers()
    expect(secondPane.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(events[0]).toMatchObject({ trigger: 'deferred' })
  })

  it('does no owner discovery while the renderer-wide gate still denies the service', () => {
    const paneAtlas = atlas()
    const pane = fakePane(paneAtlas)
    register(true, [pane])
    const forEach = vi.spyOn(
      registered[0] as { forEachInternalPane: () => void },
      'forEachInternalPane'
    )

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    forEach.mockClear()
    // Fire early: the gate still denies, so the service re-arms without scanning.
    const early = timers.shift()
    early?.callback()

    expect(forEach).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
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

  it('retires a deferred check when no eligible owner remains or it expired', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const shared = atlas()
      const pane = fakePane(shared)
      register(true, [pane])

      verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
      vi.setSystemTime(Date.now() + 31_000)
      runTimers()

      expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
      expect(timers).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the atlas-change check on a later task, after xterm assigns the atlas', () => {
    const pane = fakePane(atlas())
    register(true, [pane])

    requestAtlasChangeIntegrityCheck(pane, deps(blank))
    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    runTimers()
    expect(events[0]).toMatchObject({ trigger: 'atlas-change', outcome: 'reset' })
  })

  it('retires an atlas-change hint whose publishing addon was replaced', () => {
    const pane = fakePane(atlas())
    register(true, [pane])

    requestAtlasChangeIntegrityCheck(pane, deps(blank))
    pane.webglAddon = { ...pane.addon } as never
    runTimers()

    expect(events).toEqual([])
    expect(state.lastAttemptAt).toBe(Number.NEGATIVE_INFINITY)
  })

  it('charges an admitted request even when its requester is not eligible', () => {
    const shared = atlas()
    const covered = fakePane(shared, { covered: true })
    const visible = fakePane(atlas())
    register(true, [covered, visible])

    verifyPaneWebglAtlasIntegrity(covered, 'reveal', deps(blank))
    verifyPaneWebglAtlasIntegrity(visible, 'reveal', deps(blank))

    expect(visible.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
  })

  it('keeps at most eight pending atlases, dropping the oldest', () => {
    const first = fakePane(atlas())
    register(true, [first])
    verifyPaneWebglAtlasIntegrity(first, 'reveal', deps(ink))
    const waiting = Array.from({ length: 9 }, () => fakePane(atlas()))
    register(true, waiting)
    for (const pane of waiting) {
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(ink))
    }

    expect(state.pending.size).toBe(8)
    expect(
      [...state.pending.keys()].some((ref) => ref.deref() === atlasOfPaneFor(waiting[0]))
    ).toBe(false)
    expect(timers).toHaveLength(1)
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
