import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { forEachVisibleInternalPane, isElementInVisiblePaneManager } from '../pane-manager-registry'
import { isManagedPaneDisplayNone } from '../terminal-fit/pane-display-visibility'
import { getWindowParkVisible } from '../../window-activity/window-park-visibility'
import { presentPaneViewport } from './pane-viewport-present'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'

/**
 * xterm shares one glyph atlas per font/colour config and never rechecks the page pixels behind a cache
 * entry, and reveal keeps the atlas. If a page loses its pixels (an unconfirmed hypothesis for STA-17523),
 * every renderer that uploads it draws blanks. Sample glyph rects that provably held ink and evict the atlas
 * when one reads blank. This does not detect glyphs cached empty or stale per-renderer GPU textures.
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

export type GlyphAtlasLike = {
  readonly pages: readonly AtlasPageLike[]
  readonly pageLayoutVersion?: number
}

export type InkRead = 'ink' | 'blank' | 'unreadable'
export type GlyphInkReader = (canvas: AtlasCanvas, rect: GlyphRect) => InkRead

export type AtlasPoisonFinding = { reason: 'blank-page-glyph'; page: number; pageSize: number }

export type AtlasCheckResult =
  | { outcome: 'poisoned'; finding: AtlasPoisonFinding; reads: number }
  | { outcome: 'healthy' | 'inconclusive'; reads: number }

const MAX_RECT_SIZE = 256
const MAX_VISITS_PER_PAGE = 64
const MAX_VISITS_PER_ATTEMPT = 1024

/**
 * xterm sets offset.y = padding - top + adj (padding 4, or 0 for restricted glyphs; adj >= 0), and a missed
 * top scan leaves top = 0. So offset.y <= -1 means the scan found an inked pixel, which lies inside the crop
 * xterm packs; an intact page therefore shows ink in this rect. Other glyphs are not evidence either way.
 */
export function admittedRect(glyph: AtlasGlyph, canvas: AtlasCanvas): GlyphRect | null {
  const { texturePosition: position, size, offset } = glyph
  if (!position || !size || !offset || !(offset.y <= -1)) {
    return null
  }
  const rect = { x: position.x, y: position.y, width: size.x, height: size.y }
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
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

/** Per atlas and page: where the next visit starts, so every glyph is reached across attempts. */
type Traversal = { layoutVersion: number | undefined; cursors: number[]; startPage: number }

export function checkAtlasIntegrity(
  atlas: GlyphAtlasLike,
  read: GlyphInkReader,
  traversal: Traversal,
  maxReads: number
): AtlasCheckResult {
  if (traversal.layoutVersion !== atlas.pageLayoutVersion) {
    traversal.layoutVersion = atlas.pageLayoutVersion
    traversal.cursors = []
  }
  let reads = 0
  let inked = 0
  let visitsLeft = MAX_VISITS_PER_ATTEMPT
  const pageCount = atlas.pages.length
  const firstPage = pageCount ? traversal.startPage % pageCount : 0
  traversal.startPage = firstPage + 1
  for (let step = 0; step < pageCount && visitsLeft > 0; step++) {
    const page = (firstPage + step) % pageCount
    const { canvas, glyphs } = atlas.pages[page]
    if (!canvas?.width || !canvas.height || !glyphs?.length) {
      continue
    }
    const visits = Math.min(glyphs.length, MAX_VISITS_PER_PAGE, visitsLeft)
    const start = (traversal.cursors[page] ?? 0) % glyphs.length
    traversal.cursors[page] = start + visits
    visitsLeft -= visits
    const quadrants: (GlyphRect | undefined)[] = []
    for (let i = 0; i < visits; i++) {
      const rect = admittedRect(glyphs[(start + i) % glyphs.length], canvas)
      if (rect) {
        const quadrant = (rect.x >= canvas.width / 2 ? 1 : 0) + (rect.y >= canvas.height / 2 ? 2 : 0)
        quadrants[quadrant] ??= rect
      }
    }
    for (const rect of quadrants) {
      if (!rect || reads >= maxReads) {
        continue
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
  return { outcome: inked > 0 && inked === reads ? 'healthy' : 'inconclusive', reads }
}

const SCRATCH_WIDTH = MAX_RECT_SIZE + 2
const DESTINATION_CONTROL_X = MAX_RECT_SIZE
const SOURCE_CONTROL_X = MAX_RECT_SIZE + 1

type ReadKit = { ctx: CanvasRenderingContext2D; control: HTMLCanvasElement }

function createKit(): ReadKit | null {
  if (typeof document === 'undefined') {
    return null
  }
  const element = document.createElement('canvas')
  element.width = SCRATCH_WIDTH
  element.height = MAX_RECT_SIZE
  const ctx = element.getContext('2d', { alpha: true, willReadFrequently: true })
  const control = document.createElement('canvas')
  control.width = 1
  control.height = 1
  const controlContext = control.getContext('2d')
  if (!ctx || !controlContext) {
    return null
  }
  controlContext.fillStyle = '#000'
  controlContext.fillRect(0, 0, 1, 1)
  return { ctx, control }
}

function isUsable(ctx: CanvasRenderingContext2D): boolean {
  return ctx.getContextAttributes?.().alpha !== false && ctx.isContextLost?.() !== true
}

function readOnce(current: ReadKit, canvas: AtlasCanvas, rect: GlyphRect): InkRead | 'control-failed' {
  const { ctx, control } = current
  if (!isUsable(ctx)) {
    return 'control-failed'
  }
  const height = Math.max(1, rect.height)
  ctx.clearRect(0, 0, SCRATCH_WIDTH, height)
  // Source-over onto transparent pixels reproduces the source's alpha.
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
  ctx.fillStyle = '#000'
  ctx.fillRect(DESTINATION_CONTROL_X, 0, 1, 1)
  ctx.drawImage(control, SOURCE_CONTROL_X, 0)
  const pixels = ctx.getImageData(0, 0, SCRATCH_WIDTH, height).data
  const rowStride = SCRATCH_WIDTH * 4
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (pixels[y * rowStride + x * 4 + 3] > 0) {
        return 'ink'
      }
    }
  }
  const controlsPassed =
    pixels[DESTINATION_CONTROL_X * 4 + 3] === 255 && pixels[SOURCE_CONTROL_X * 4 + 3] === 255
  return controlsPassed && isUsable(ctx) ? 'blank' : 'control-failed'
}

/**
 * Blank only when both fresh controls drawn after the copy read back opaque. Residual: the controls prove
 * the scratch and a canvas copy work, not the transfer from this particular page canvas.
 */
export function createGlyphInkReader(makeKit: () => ReadKit | null = createKit): GlyphInkReader {
  let kit: ReadKit | null = null
  return (canvas, rect) => {
    for (let tries = 0; tries < 2; tries++) {
      kit ??= makeKit()
      if (!kit) {
        return 'unreadable'
      }
      const result = readOnce(kit, canvas, rect)
      if (result !== 'control-failed') {
        return result
      }
      kit = null
    }
    return 'unreadable'
  }
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

function isWindowPresented(): boolean {
  return (
    getWindowParkVisible() &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  )
}

function isEligibleOwner(pane: ManagedPaneInternal, atlas: GlyphAtlasLike): boolean {
  try {
    const renderer = (pane.webglAddon as unknown as WebglInternals | null)?._renderer
    const terminalElement = (pane.terminal as { element?: { isConnected?: boolean } }).element
    return (
      !!pane.webglAddon &&
      !pane.webglDisabledAfterContextLoss &&
      typeof renderer?._gl?.isContextLost === 'function' &&
      renderer._gl.isContextLost() === false &&
      atlasOfPane(pane) === atlas &&
      pane.container.isConnected &&
      terminalElement?.isConnected === true &&
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
  isWindowPresented: () => boolean
  state: AtlasIntegrityState
}

type AtlasState = {
  completedAt: number
  traversal: Traversal
  resetAt: number
  resets: number
}

export type AtlasIntegrityState = {
  atlases: WeakMap<GlyphAtlasLike, AtlasState>
  pending: Map<WeakRef<GlyphAtlasLike>, number>
  timerArmed: boolean
  readTimes: number[]
  lastAttemptAt: number
  resets: number
}

export function createAtlasIntegrityState(): AtlasIntegrityState {
  return {
    atlases: new WeakMap(),
    pending: new Map(),
    timerArmed: false,
    readTimes: [],
    lastAttemptAt: Number.NEGATIVE_INFINITY,
    resets: 0
  }
}

const defaultDeps: AtlasIntegrityDeps = {
  now: () => performance.now(),
  read: createGlyphInkReader(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  isWindowPresented,
  state: createAtlasIntegrityState()
}

const ATLAS_COOLDOWN_MS = 10_000
const GLOBAL_SPACING_MS = 50
const READ_WINDOW_MS = 1_000
const MAX_READS_PER_WINDOW = 16
const PENDING_EXPIRY_MS = 30_000
const RESET_INTERVAL_MS = 60_000
const MAX_RESETS_PER_ATLAS = 3
const MAX_RESETS_PER_SESSION = 10

function stateOf(deps: AtlasIntegrityDeps, atlas: GlyphAtlasLike): AtlasState {
  let state = deps.state.atlases.get(atlas)
  if (!state) {
    state = {
      completedAt: Number.NEGATIVE_INFINITY,
      traversal: { layoutVersion: undefined, cursors: [], startPage: 0 },
      resetAt: Number.NEGATIVE_INFINITY,
      resets: 0
    }
    deps.state.atlases.set(atlas, state)
  }
  return state
}

function readsLeft(deps: AtlasIntegrityDeps, now: number): number {
  const times = deps.state.readTimes
  while (times.length && now - times[0] >= READ_WINDOW_MS) {
    times.shift()
  }
  return MAX_READS_PER_WINDOW - times.length
}

/** Renderer-wide gates, checked before any discovery or traversal. */
function globalReadyAt(deps: AtlasIntegrityDeps, now: number): number {
  const budgetAt = readsLeft(deps, now) > 0 ? now : deps.state.readTimes[0] + READ_WINDOW_MS
  return Math.max(deps.state.lastAttemptAt + GLOBAL_SPACING_MS, budgetAt)
}

function trace(entry: { trigger: AtlasCheckTrigger; outcome: string; reads: number; page?: number }): void {
  const hook = (globalThis as { __orcaAtlasIntegrityTrace?: (entry: object) => void })
    .__orcaAtlasIntegrityTrace
  if (typeof hook === 'function') {
    try {
      hook(entry)
    } catch {
      // Dev observation only.
    }
  }
}

function presentEligibleOwners(atlas: GlyphAtlasLike): void {
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

function reset(
  owner: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  state: AtlasState,
  finding: AtlasPoisonFinding,
  trigger: AtlasCheckTrigger,
  now: number,
  deps: AtlasIntegrityDeps
): string {
  const allowed =
    deps.state.resets < MAX_RESETS_PER_SESSION &&
    state.resets < MAX_RESETS_PER_ATLAS &&
    now - state.resetAt >= RESET_INTERVAL_MS
  let outcome: 'reset' | 'reset-failed' | 'refused' = 'refused'
  if (allowed) {
    state.resets++
    state.resetAt = now
    deps.state.resets++
    const before = atlas.pageLayoutVersion
    try {
      owner.webglAddon?.clearTextureAtlas()
    } catch {
      // Read below: eviction may have committed before the throw.
    }
    // Same object, before any presentation can rasterize into it again.
    const evicted =
      atlas.pageLayoutVersion !== before &&
      atlas.pages.length === 1 &&
      (atlas.pages[0].glyphs?.length ?? 0) === 0
    outcome = evicted ? 'reset' : 'reset-failed'
  }
  recordTerminalWebglDiagnostic('webgl-atlas-poisoned', {
    ...finding,
    outcome,
    trigger,
    pages: atlas.pages.length
  })
  if (outcome !== 'refused') {
    console.warn('[terminal] WebGL glyph atlas page lost its pixels; evicted the atlas', outcome)
    presentEligibleOwners(atlas)
  }
  return outcome
}

function attempt(
  owner: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  trigger: AtlasCheckTrigger,
  deps: AtlasIntegrityDeps
): void {
  const now = deps.now()
  const state = stateOf(deps, atlas)
  deps.state.lastAttemptAt = now
  const result = checkAtlasIntegrity(atlas, deps.read, state.traversal, readsLeft(deps, now))
  for (let i = 0; i < result.reads; i++) {
    deps.state.readTimes.push(now)
  }
  if (result.reads > 0) {
    state.completedAt = now
  }
  const outcome =
    result.outcome === 'poisoned'
      ? reset(owner, atlas, state, result.finding, trigger, now, deps)
      : result.outcome
  trace({
    trigger,
    outcome,
    reads: result.reads,
    ...(result.outcome === 'poisoned' ? { page: result.finding.page } : {})
  })
}

function armService(deps: AtlasIntegrityDeps, now: number): void {
  if (deps.state.timerArmed || deps.state.pending.size === 0) {
    return
  }
  deps.state.timerArmed = true
  deps.setTimer(() => service(deps), Math.max(0, globalReadyAt(deps, now) - now))
}

function enqueue(atlas: GlyphAtlasLike, deps: AtlasIntegrityDeps, now: number): void {
  for (const ref of deps.state.pending.keys()) {
    if (ref.deref() === atlas) {
      armService(deps, now)
      return
    }
  }
  deps.state.pending.set(new WeakRef(atlas), Date.now())
  armService(deps, now)
}

/** One renderer-wide service: gates first, then at most one discovery scan and one attempt per firing. */
function service(deps: AtlasIntegrityDeps): void {
  try {
    deps.state.timerArmed = false
    const now = deps.now()
    if (now < globalReadyAt(deps, now)) {
      armService(deps, now)
      return
    }
    const wallNow = Date.now()
    let chosen: GlyphAtlasLike | undefined
    let soonest = Number.POSITIVE_INFINITY
    for (const [ref, queuedAt] of deps.state.pending) {
      const atlas = ref.deref()
      if (!atlas || wallNow - queuedAt > PENDING_EXPIRY_MS) {
        deps.state.pending.delete(ref)
        continue
      }
      const readyAt = stateOf(deps, atlas).completedAt + ATLAS_COOLDOWN_MS
      if (readyAt <= now) {
        deps.state.pending.delete(ref)
        chosen = atlas
        break
      }
      soonest = Math.min(soonest, readyAt)
    }
    if (!chosen) {
      if (deps.state.pending.size > 0) {
        deps.state.timerArmed = true
        deps.setTimer(() => service(deps), Math.max(0, soonest - now))
      }
      return
    }
    deps.state.lastAttemptAt = now
    let owner: ManagedPaneInternal | undefined
    if (deps.isWindowPresented()) {
      forEachVisibleInternalPane((pane) => {
        if (isEligibleOwner(pane, chosen)) {
          owner = pane
          return true
        }
        return false
      })
    }
    if (owner) {
      attempt(owner, chosen, 'deferred', deps)
    }
    armService(deps, now)
  } catch {
    // Diagnostics-only path.
  }
}

/** Checks the pane's shared atlas now or later; never throws into reveal, attach or xterm's events. */
export function verifyPaneWebglAtlasIntegrity(
  pane: ManagedPaneInternal,
  trigger: AtlasCheckTrigger,
  deps: AtlasIntegrityDeps = defaultDeps
): void {
  try {
    const now = deps.now()
    const atlas = atlasOfPane(pane)
    if (!atlas || !deps.isWindowPresented()) {
      return
    }
    const cooldownAt = stateOf(deps, atlas).completedAt + ATLAS_COOLDOWN_MS
    if (now < Math.max(globalReadyAt(deps, now), cooldownAt)) {
      enqueue(atlas, deps, now)
      return
    }
    if (isEligibleOwner(pane, atlas)) {
      attempt(pane, atlas, trigger, deps)
    }
  } catch {
    // Diagnostics-only path: a failed check must never fail its caller.
  }
}

/** xterm reports an atlas change before assigning it, so resolve it on the next task. */
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
