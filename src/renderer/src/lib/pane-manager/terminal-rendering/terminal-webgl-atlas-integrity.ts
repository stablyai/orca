import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { forEachVisibleInternalPane, isElementInVisiblePaneManager } from '../pane-manager-registry'
import { isManagedPaneDisplayNone } from '../terminal-fit/pane-display-visibility'
import { presentPaneViewport } from './pane-viewport-present'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'

/**
 * xterm shares one glyph atlas per font/colour config and never rechecks the page pixels behind a cache
 * entry, and reveal keeps the atlas. If a page loses its pixels (unconfirmed hypothesis behind STA-17523),
 * every renderer that uploads it draws blanks. Sample glyph rects that must hold ink and evict the atlas
 * when one reads blank. Detection only covers that case; it does not detect glyphs cached empty or stale
 * per-renderer GPU textures.
 */

export type GlyphRect = { x: number; y: number; width: number; height: number }

type AtlasGlyph = {
  texturePosition?: { x: number; y: number }
  size?: { x: number; y: number }
  offset?: { x: number; y: number }
}

type AtlasCanvas = { width: number; height: number }

type AtlasPageLike = {
  canvas?: AtlasCanvas
  glyphs?: readonly AtlasGlyph[]
}

export type GlyphAtlasLike = { readonly pages: readonly AtlasPageLike[] }

export type InkRead = 'ink' | 'blank' | 'unreadable'
export type GlyphInkReader = (canvas: AtlasCanvas, rect: GlyphRect) => InkRead

export type AtlasPoisonFinding = { reason: 'blank-page-glyph'; page: number; pageSize: number }

export type AtlasCheckResult =
  | { outcome: 'poisoned'; finding: AtlasPoisonFinding; reads: number }
  | { outcome: 'healthy' | 'inconclusive'; reads: number }

const MAX_RECT_SIZE = 256
const MAX_GLYPHS_SCANNED_PER_PAGE = 64
const MAX_GLYPHS_SCANNED_PER_CHECK = 1024
// xterm's TMP_CANVAS_GLYPH_PADDING: offset.y = padding - top + (non-negative adjustment).
const GLYPH_PADDING = 2

/**
 * offset.y <= padding - 1 means the top scan found ink at row top >= 1, and that pixel lies inside the
 * packed crop, so an intact page shows ink there. Anything else is not evidence either way.
 */
function admittedRect(glyph: AtlasGlyph, canvas: AtlasCanvas): GlyphRect | null {
  const position = glyph.texturePosition
  const size = glyph.size
  const offset = glyph.offset
  if (!position || !size || !offset || !(offset.y <= GLYPH_PADDING - 1)) {
    return null
  }
  const rect = { x: position.x, y: position.y, width: size.x, height: size.y }
  const integral = [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
  if (
    !integral ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > MAX_RECT_SIZE ||
    rect.height > MAX_RECT_SIZE ||
    rect.x + rect.width > canvas.width ||
    rect.y + rect.height > canvas.height
  ) {
    return null
  }
  return rect
}

/** The k-th admitted glyph of each page quadrant, so successive checks cover neighbours and merged sources. */
function pageSamples(
  canvas: AtlasCanvas,
  glyphs: readonly AtlasGlyph[],
  round: number,
  scanBudget: { left: number }
): GlyphRect[] {
  const seen = [0, 0, 0, 0]
  const firsts: (GlyphRect | undefined)[] = []
  const picks: (GlyphRect | undefined)[] = []
  const limit = Math.min(glyphs.length, MAX_GLYPHS_SCANNED_PER_PAGE)
  for (let i = 0; i < limit && scanBudget.left > 0; i++) {
    scanBudget.left--
    const rect = admittedRect(glyphs[i], canvas)
    if (!rect) {
      continue
    }
    const quadrant = (rect.x >= canvas.width / 2 ? 1 : 0) + (rect.y >= canvas.height / 2 ? 2 : 0)
    firsts[quadrant] ??= rect
    if (seen[quadrant]++ === round % MAX_GLYPHS_SCANNED_PER_PAGE) {
      picks[quadrant] = rect
    }
  }
  // Wrap to the first admitted rect when a quadrant has fewer than k+1.
  return [0, 1, 2, 3].map((q) => picks[q] ?? firsts[q]).filter((rect): rect is GlyphRect => !!rect)
}

export function checkAtlasIntegrity(
  atlas: GlyphAtlasLike,
  read: GlyphInkReader,
  options: { startPage: number; round: number; maxReads: number }
): AtlasCheckResult {
  let reads = 0
  let inked = 0
  const scanBudget = { left: MAX_GLYPHS_SCANNED_PER_CHECK }
  const pageCount = atlas.pages.length
  for (let step = 0; step < pageCount && reads < options.maxReads && scanBudget.left > 0; step++) {
    const page = (options.startPage + step) % pageCount
    const { canvas, glyphs } = atlas.pages[page]
    if (!canvas?.width || !canvas.height || !glyphs?.length) {
      continue
    }
    for (const rect of pageSamples(canvas, glyphs, options.round, scanBudget)) {
      if (reads >= options.maxReads) {
        break
      }
      reads++
      let result: InkRead
      try {
        result = read(canvas, rect)
      } catch {
        result = 'unreadable'
      }
      if (result === 'blank') {
        return {
          outcome: 'poisoned',
          finding: { reason: 'blank-page-glyph', page, pageSize: canvas.width },
          reads
        }
      }
      if (result === 'ink') {
        inked++
      }
    }
  }
  return { outcome: inked > 0 ? 'healthy' : 'inconclusive', reads }
}

const SCRATCH_WIDTH = MAX_RECT_SIZE + 1
let scratch: CanvasRenderingContext2D | null | undefined
let sourceControl: HTMLCanvasElement | null = null

function scratchContext(): CanvasRenderingContext2D | null {
  if (scratch === undefined) {
    scratch = null
    if (typeof document !== 'undefined') {
      const element = document.createElement('canvas')
      element.width = SCRATCH_WIDTH
      element.height = MAX_RECT_SIZE
      scratch = element.getContext('2d', { alpha: true, willReadFrequently: true })
      const control = document.createElement('canvas')
      control.width = 1
      control.height = 1
      const controlContext = control.getContext('2d')
      if (controlContext) {
        controlContext.fillStyle = '#000'
        controlContext.fillRect(0, 0, 1, 1)
        sourceControl = control
      }
    }
  }
  return scratch
}

function usable(ctx: CanvasRenderingContext2D): boolean {
  return ctx.getContextAttributes?.().alpha !== false && ctx.isContextLost?.() !== true
}

/** Blank only when both controls read back opaque; residual: they cannot prove this source's transfer. */
export function readGlyphInk(canvas: AtlasCanvas, rect: GlyphRect): InkRead {
  const ctx = scratchContext()
  if (!ctx || !sourceControl || !usable(ctx)) {
    return 'unreadable'
  }
  ctx.save()
  ctx.globalCompositeOperation = 'copy'
  ctx.clearRect(0, 0, SCRATCH_WIDTH, rect.height)
  ctx.restore()
  ctx.fillStyle = '#000'
  ctx.fillRect(MAX_RECT_SIZE, 0, 1, 1)
  ctx.drawImage(sourceControl, MAX_RECT_SIZE, 1)
  ctx.save()
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(
    canvas as unknown as CanvasImageSource,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  )
  ctx.restore()
  const pixels = ctx.getImageData(0, 0, SCRATCH_WIDTH, Math.max(2, rect.height)).data
  if (!usable(ctx)) {
    return 'unreadable'
  }
  const rowStride = SCRATCH_WIDTH * 4
  const controlAlpha = MAX_RECT_SIZE * 4 + 3
  if (pixels[controlAlpha] !== 255 || pixels[rowStride + controlAlpha] !== 255) {
    return 'unreadable'
  }
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (pixels[y * rowStride + x * 4 + 3] > 0) {
        return 'ink'
      }
    }
  }
  return 'blank'
}

type WebglInternals = {
  _renderer?: { _charAtlas?: unknown; _gl?: { isContextLost?: () => boolean } }
}

export function atlasOfPane(pane: ManagedPaneInternal): GlyphAtlasLike | undefined {
  try {
    const atlas = (pane.webglAddon as unknown as WebglInternals | null)?._renderer?._charAtlas as
      | GlyphAtlasLike
      | undefined
    return atlas && Array.isArray(atlas.pages) ? atlas : undefined
  } catch {
    return undefined
  }
}

function isEligibleOwner(pane: ManagedPaneInternal, atlas: GlyphAtlasLike): boolean {
  try {
    const renderer = (pane.webglAddon as unknown as WebglInternals | null)?._renderer
    return (
      !!pane.webglAddon &&
      !pane.webglDisabledAfterContextLoss &&
      renderer?._gl?.isContextLost?.() !== true &&
      atlasOfPane(pane) === atlas &&
      pane.container.isConnected &&
      isElementInVisiblePaneManager(pane.container) &&
      !isManagedPaneDisplayNone(pane) &&
      !paneIsCoveredByNativeChat(pane)
    )
  } catch {
    return false
  }
}

export type AtlasCheckTrigger = 'reveal' | 'attach' | 'atlas-change' | 'deferred'

export type AtlasIntegrityDeps = {
  now: () => number
  read: GlyphInkReader
  setTimer: (callback: () => void, ms: number) => unknown
  session: { resets: number }
}

const defaultDeps: AtlasIntegrityDeps = {
  now: () => performance.now(),
  read: readGlyphInk,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  session: { resets: 0 }
}

const ATLAS_COOLDOWN_MS = 10_000
const GLOBAL_SPACING_MS = 50
const READ_WINDOW_MS = 1_000
const MAX_READS_PER_WINDOW = 16
const RESET_INTERVAL_MS = 60_000
const MAX_RESETS_PER_ATLAS = 3
const MAX_RESETS_PER_SESSION = 10

type AtlasState = {
  completedAt: number
  startPage: number
  round: number
  resetAt: number
  resets: number
  timerArmed: boolean
}

const atlasStates = new WeakMap<GlyphAtlasLike, AtlasState>()
const readTimes: number[] = []
let lastAttemptAt = Number.NEGATIVE_INFINITY

function stateOf(atlas: GlyphAtlasLike): AtlasState {
  let state = atlasStates.get(atlas)
  if (!state) {
    state = {
      completedAt: Number.NEGATIVE_INFINITY,
      startPage: 0,
      round: 0,
      resetAt: Number.NEGATIVE_INFINITY,
      resets: 0,
      timerArmed: false
    }
    atlasStates.set(atlas, state)
  }
  return state
}

function readsLeft(now: number): number {
  while (readTimes.length && now - readTimes[0] >= READ_WINDOW_MS) {
    readTimes.shift()
  }
  return MAX_READS_PER_WINDOW - readTimes.length
}

function readyAt(state: AtlasState, now: number): number {
  const budgetAt = readsLeft(now) > 0 ? now : readTimes[0] + READ_WINDOW_MS
  return Math.max(state.completedAt + ATLAS_COOLDOWN_MS, lastAttemptAt + GLOBAL_SPACING_MS, budgetAt)
}

function isEvicted(atlas: GlyphAtlasLike): boolean {
  return atlas.pages.length === 1 && (atlas.pages[0].glyphs?.length ?? 0) === 0
}

function reset(
  owner: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  state: AtlasState,
  finding: AtlasPoisonFinding,
  trigger: AtlasCheckTrigger,
  now: number,
  session: AtlasIntegrityDeps['session']
): void {
  const allowed =
    session.resets < MAX_RESETS_PER_SESSION &&
    state.resets < MAX_RESETS_PER_ATLAS &&
    now - state.resetAt >= RESET_INTERVAL_MS
  let outcome: 'reset' | 'reset-failed' | 'refused' = 'refused'
  if (allowed) {
    state.resets++
    state.resetAt = now
    session.resets++
    try {
      // Evicts the shared atlas; every owner rebuilds its model from the new layout generation.
      owner.webglAddon?.clearTextureAtlas()
      outcome = isEvicted(atlas) ? 'reset' : 'reset-failed'
    } catch {
      outcome = 'reset-failed'
    }
  }
  recordTerminalWebglDiagnostic('webgl-atlas-poisoned', {
    ...finding,
    outcome,
    trigger,
    pages: atlas.pages.length
  })
  if (outcome === 'refused') {
    return
  }
  console.warn('[terminal] WebGL glyph atlas page lost its pixels; evicted the atlas', finding, outcome)
  forEachVisibleInternalPane((pane) => {
    if (isEligibleOwner(pane, atlas)) {
      try {
        presentPaneViewport(pane)
      } catch {
        // One owner's failed present must not stop its siblings.
      }
    }
  })
}

function attempt(
  owner: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  trigger: AtlasCheckTrigger,
  deps: AtlasIntegrityDeps
): void {
  const state = stateOf(atlas)
  const now = deps.now()
  const at = readyAt(state, now)
  if (now < at) {
    defer(atlas, state, at - now, deps)
    return
  }
  lastAttemptAt = now
  const result = checkAtlasIntegrity(atlas, deps.read, {
    startPage: state.startPage,
    round: state.round,
    maxReads: readsLeft(now)
  })
  for (let i = 0; i < result.reads; i++) {
    readTimes.push(now)
  }
  if (result.reads === 0) {
    // No atlas content to sample yet; a later reveal, attach or atlas change may.
    return
  }
  state.completedAt = now
  state.startPage = atlas.pages.length ? (state.startPage + 1) % atlas.pages.length : 0
  state.round++
  if (result.outcome === 'poisoned') {
    reset(owner, atlas, state, result.finding, trigger, now, deps.session)
  }
}

function defer(atlas: GlyphAtlasLike, state: AtlasState, ms: number, deps: AtlasIntegrityDeps): void {
  if (state.timerArmed) {
    return
  }
  state.timerArmed = true
  const atlasRef = new WeakRef(atlas)
  deps.setTimer(() => {
    const pending = atlasRef.deref()
    if (!pending) {
      return
    }
    stateOf(pending).timerArmed = false
    // The requester may be gone; any still-eligible owner of the atlas can carry the check.
    let owner: ManagedPaneInternal | undefined
    forEachVisibleInternalPane((pane) => {
      if (isEligibleOwner(pane, pending)) {
        owner = pane
        return true
      }
      return false
    })
    if (owner) {
      attempt(owner, pending, 'deferred', deps)
    }
  }, ms)
}

/** Checks the pane's shared atlas now or when allowed; never throws into reveal, attach or render. */
export function verifyPaneWebglAtlasIntegrity(
  pane: ManagedPaneInternal,
  trigger: AtlasCheckTrigger,
  deps: AtlasIntegrityDeps = defaultDeps
): void {
  try {
    const atlas = atlasOfPane(pane)
    if (atlas && isEligibleOwner(pane, atlas)) {
      attempt(pane, atlas, trigger, deps)
    }
  } catch {
    // Diagnostics-only path: a failed check must never fail its caller.
  }
}

/** xterm reports an atlas change before installing it, so look on the next task. */
export function requestAtlasChangeIntegrityCheck(
  pane: ManagedPaneInternal,
  deps: AtlasIntegrityDeps = defaultDeps
): void {
  try {
    deps.setTimer(() => verifyPaneWebglAtlasIntegrity(pane, 'atlas-change', deps), 0)
  } catch {
    // Same containment as the direct check.
  }
}
