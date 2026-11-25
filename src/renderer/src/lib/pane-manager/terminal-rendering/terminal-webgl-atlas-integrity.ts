import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { presentVisiblePanesWhere } from '../pane-manager-registry'
import { isManagedPaneDisplayNone } from '../terminal-fit/pane-display-visibility'
import { presentPaneViewport } from './pane-viewport-present'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'

/**
 * xterm shares one glyph atlas per font/colour config and never rechecks the page pixels behind a cache
 * entry, while reveal keeps the atlas. Hypothesis behind STA-17523: entries whose pixels are gone, or
 * letters cached empty, make every renderer that uploads the atlas draw blanks. On reveal and attach,
 * sample the atlas and rebuild it when it provably holds an inkless entry.
 */

export type GlyphRect = { x: number; y: number; width: number; height: number }

type AtlasGlyph = {
  texturePosition?: { x: number; y: number }
  size?: { x: number; y: number }
}

type AtlasCanvas = { width: number; height: number }

type AtlasPageLike = {
  canvas?: AtlasCanvas
  glyphs?: readonly AtlasGlyph[]
}

type AtlasColor = { rgba?: number }

export type GlyphAtlasLike = {
  readonly pages: readonly AtlasPageLike[]
  _cacheMap?: { get(code: number, bg: number, fg: number, ext: number): AtlasGlyph | undefined }
  _config?: { colors?: { foreground?: AtlasColor; background?: AtlasColor } }
}

export type AtlasPoisonFinding =
  | { reason: 'blank-page-glyph'; page: number; pageSize: number }
  | { reason: 'empty-cached-glyph'; probe: number }

export type AtlasCheckResult =
  | { outcome: 'poisoned'; finding: AtlasPoisonFinding }
  | { outcome: 'healthy' | 'inconclusive' }

/** true: ink found; false: provably no ink; null: unreadable. */
export type GlyphInkReader = (canvas: AtlasCanvas, rect: GlyphRect) => boolean | null

// Pages wider than this are xterm's device-sized oversized-glyph page.
const MAX_SAMPLED_PAGE_SIZE = 4096
const MAX_RECT_SIZE = 256
const MAX_RECTS_PER_CHECK = 16
const PROBE_CODES = Array.from('aenost', (char) => char.charCodeAt(0))
// xterm's DEFAULT_COLOR and DEFAULT_EXT.
const DEFAULT_KEY = 0
const MIN_DEFAULT_COLOR_DISTANCE = 128

function hasArea(size: AtlasGlyph['size']): size is { x: number; y: number } {
  return !!size && size.x > 0 && size.y > 0
}

function hasPackedGlyph(atlas: GlyphAtlasLike): boolean {
  return atlas.pages.some((page) => (page.glyphs?.length ?? 0) > 0)
}

/** Default letters are only certain to have ink when the theme's default colours clearly differ. */
function defaultColoursAlwaysInk(atlas: GlyphAtlasLike): boolean {
  const fg = atlas._config?.colors?.foreground?.rgba
  const bg = atlas._config?.colors?.background?.rgba
  if (typeof fg !== 'number' || typeof bg !== 'number' || (fg & 0xff) !== 0xff) {
    return false
  }
  let distance = 0
  for (const shift of [24, 16, 8]) {
    distance += Math.abs(((fg >>> shift) & 0xff) - ((bg >>> shift) & 0xff))
  }
  return distance >= MIN_DEFAULT_COLOR_DISTANCE
}

/** One packed glyph per page quadrant, so each source page of a merge is represented. */
function quadrantSamples(canvas: AtlasCanvas, glyphs: readonly AtlasGlyph[]): GlyphRect[] {
  const samples: (GlyphRect | undefined)[] = [undefined, undefined, undefined, undefined]
  let found = 0
  for (const glyph of glyphs) {
    const position = glyph.texturePosition
    if (!position || !hasArea(glyph.size)) {
      continue
    }
    const quadrant =
      (position.x >= canvas.width / 2 ? 1 : 0) + (position.y >= canvas.height / 2 ? 2 : 0)
    if (samples[quadrant]) {
      continue
    }
    samples[quadrant] = {
      x: position.x,
      y: position.y,
      width: glyph.size.x,
      height: glyph.size.y
    }
    if (++found === 4) {
      break
    }
  }
  return samples.filter((rect): rect is GlyphRect => !!rect)
}

function isReadableRect(canvas: AtlasCanvas, rect: GlyphRect): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width <= MAX_RECT_SIZE &&
    rect.height <= MAX_RECT_SIZE &&
    rect.x + rect.width <= canvas.width &&
    rect.y + rect.height <= canvas.height
  )
}

/**
 * xterm packs a glyph only after finding ink, at exactly its ink bounding box, and merges copy pages 1:1,
 * so an intact page never has an inkless packed rect. Unread or unsupported samples are inconclusive.
 */
export function checkAtlasIntegrity(
  atlas: GlyphAtlasLike,
  hasInk: GlyphInkReader,
  startPage = 0
): AtlasCheckResult {
  let read = 0
  let budget = MAX_RECTS_PER_CHECK
  const pageCount = atlas.pages.length
  for (let step = 0; step < pageCount && budget > 0; step++) {
    const page = (startPage + step) % pageCount
    const { canvas, glyphs } = atlas.pages[page]
    if (!canvas?.width || !canvas.height || canvas.width > MAX_SAMPLED_PAGE_SIZE || !glyphs) {
      continue
    }
    for (const rect of quadrantSamples(canvas, glyphs)) {
      if (budget-- <= 0) {
        break
      }
      if (!isReadableRect(canvas, rect)) {
        continue
      }
      let ink: boolean | null
      try {
        ink = hasInk(canvas, rect)
      } catch {
        ink = null
      }
      if (ink === false) {
        return { outcome: 'poisoned', finding: { reason: 'blank-page-glyph', page, pageSize: canvas.width } }
      }
      if (ink === true) {
        read++
      }
    }
  }
  // Without a packed glyph xterm's clearTexture is a no-op, so an empty entry there is not recoverable.
  if (hasPackedGlyph(atlas) && defaultColoursAlwaysInk(atlas)) {
    for (const probe of PROBE_CODES) {
      const glyph = atlas._cacheMap?.get(probe, DEFAULT_KEY, DEFAULT_KEY, DEFAULT_KEY)
      if (glyph && !hasArea(glyph.size)) {
        return { outcome: 'poisoned', finding: { reason: 'empty-cached-glyph', probe } }
      }
    }
  }
  return { outcome: read > 0 ? 'healthy' : 'inconclusive' }
}

let scratch: CanvasRenderingContext2D | null = null

const readGlyphInk: GlyphInkReader = (canvas, rect) => {
  if (!scratch && typeof document !== 'undefined') {
    // CPU-backed and separate, so readback never touches the GPU-backed atlas pages' own state.
    const element = document.createElement('canvas')
    element.width = MAX_RECT_SIZE
    element.height = MAX_RECT_SIZE
    scratch = element.getContext('2d', { willReadFrequently: true })
  }
  if (!scratch) {
    return null
  }
  scratch.globalCompositeOperation = 'copy'
  scratch.clearRect(0, 0, rect.width, rect.height)
  scratch.drawImage(
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
  const pixels = scratch.getImageData(0, 0, rect.width, rect.height).data
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] > 0) {
      return true
    }
  }
  return false
}

export function atlasOfPane(pane: ManagedPaneInternal): GlyphAtlasLike | undefined {
  try {
    const renderer = (pane.webglAddon as unknown as { _renderer?: { _charAtlas?: unknown } } | null)
      ?._renderer
    const atlas = renderer?._charAtlas as GlyphAtlasLike | undefined
    return atlas && Array.isArray(atlas.pages) ? atlas : undefined
  } catch {
    return undefined
  }
}

export type AtlasCheckTrigger = 'reveal' | 'attach'

const ATLAS_COOLDOWN_MS = 10_000
const GLOBAL_SPACING_MS = 50
const RECOVERY_INTERVAL_MS = 60_000
const MAX_RECOVERIES_PER_ATLAS = 3

type AtlasState = {
  checkedAt: number
  nextStartPage: number
  recoveredAt: number
  recoveries: number
  pending?: {
    pane: WeakRef<ManagedPaneInternal>
    addon: ManagedPaneInternal['webglAddon']
    trigger: AtlasCheckTrigger | 'deferred'
  }
  timer?: ReturnType<typeof setTimeout>
}

const atlasStates = new WeakMap<GlyphAtlasLike, AtlasState>()
let lastCheckAt = Number.NEGATIVE_INFINITY

export type AtlasIntegrityDeps = {
  now: () => number
  hasInk: GlyphInkReader
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
}

const defaultDeps: AtlasIntegrityDeps = {
  now: () => performance.now(),
  hasInk: readGlyphInk,
  setTimer: (callback, ms) => setTimeout(callback, ms)
}

function stateOf(atlas: GlyphAtlasLike): AtlasState {
  let state = atlasStates.get(atlas)
  if (!state) {
    state = {
      checkedAt: Number.NEGATIVE_INFINITY,
      nextStartPage: 0,
      recoveredAt: Number.NEGATIVE_INFINITY,
      recoveries: 0
    }
    atlasStates.set(atlas, state)
  }
  return state
}

function canCheckNow(pane: ManagedPaneInternal): boolean {
  return (
    !!pane.webglAddon &&
    !pane.webglDisabledAfterContextLoss &&
    pane.container.isConnected &&
    !isManagedPaneDisplayNone(pane) &&
    !paneIsCoveredByNativeChat(pane)
  )
}

function recover(
  pane: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  state: AtlasState,
  finding: AtlasPoisonFinding,
  trigger: AtlasCheckTrigger | 'deferred',
  now: number
): void {
  const allowed =
    state.recoveries < MAX_RECOVERIES_PER_ATLAS && now - state.recoveredAt >= RECOVERY_INTERVAL_MS
  recordTerminalWebglDiagnostic('webgl-atlas-poisoned', {
    ...finding,
    outcome: allowed ? 'recovered' : 'suppressed',
    trigger,
    pages: atlas.pages.length
  })
  if (!allowed) {
    return
  }
  state.recoveries++
  state.recoveredAt = now
  console.warn('[terminal] WebGL glyph atlas held glyphs with no ink; rebuilding it', finding)
  // Evicts the shared atlas; every owner rebuilds its model on its next frame.
  pane.webglAddon?.clearTextureAtlas()
  presentVisiblePanesWhere((owner) => atlasOfPane(owner) === atlas, presentPaneViewport)
}

function runCheck(
  pane: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  state: AtlasState,
  trigger: AtlasCheckTrigger | 'deferred',
  deps: AtlasIntegrityDeps
): void {
  const now = deps.now()
  lastCheckAt = now
  const result = checkAtlasIntegrity(atlas, deps.hasInk, state.nextStartPage)
  if (result.outcome === 'inconclusive') {
    return
  }
  state.checkedAt = now
  state.nextStartPage = atlas.pages.length ? (state.nextStartPage + 1) % atlas.pages.length : 0
  if (result.outcome === 'poisoned') {
    recover(pane, atlas, state, result.finding, trigger, now)
  }
}

function dispatchPending(atlas: GlyphAtlasLike, deps: AtlasIntegrityDeps): void {
  const state = atlasStates.get(atlas)
  const pending = state?.pending
  if (!state || !pending) {
    return
  }
  state.timer = undefined
  state.pending = undefined
  const pane = pending.pane.deref()
  // The pane must still show this atlas through the same renderer the request saw.
  if (!pane || pane.webglAddon !== pending.addon || atlasOfPane(pane) !== atlas || !canCheckNow(pane)) {
    return
  }
  requestCheck(pane, atlas, state, 'deferred', deps)
}

function requestCheck(
  pane: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  state: AtlasState,
  trigger: AtlasCheckTrigger | 'deferred',
  deps: AtlasIntegrityDeps
): void {
  const now = deps.now()
  const readyAt = Math.max(state.checkedAt + ATLAS_COOLDOWN_MS, lastCheckAt + GLOBAL_SPACING_MS)
  if (now >= readyAt) {
    runCheck(pane, atlas, state, trigger, deps)
    return
  }
  state.pending = {
    pane: new WeakRef(pane),
    addon: pane.webglAddon,
    trigger
  }
  if (!state.timer) {
    state.timer = deps.setTimer(() => dispatchPending(atlas, deps), readyAt - now)
  }
}

/** Checks the pane's shared atlas now or once its cooldown ends; never throws into reveal or attach. */
export function verifyPaneWebglAtlasIntegrity(
  pane: ManagedPaneInternal,
  trigger: AtlasCheckTrigger,
  deps: AtlasIntegrityDeps = defaultDeps
): void {
  try {
    if (!canCheckNow(pane)) {
      return
    }
    const atlas = atlasOfPane(pane)
    if (atlas) {
      requestCheck(pane, atlas, stateOf(atlas), trigger, deps)
    }
  } catch {
    // Diagnostics-only path: a failed check must never fail its caller.
  }
}
