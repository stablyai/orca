import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { forEachVisibleInternalPane } from '../pane-manager-registry'
import { createGlyphInkReader } from './terminal-webgl-atlas-ink-reader'
import {
  atlasOfPane,
  isEligibleOwner,
  isWindowPresented,
  presentEligibleOwners
} from './terminal-webgl-atlas-owners'
import {
  checkAtlasIntegrity,
  type AtlasPoisonFinding,
  type GlyphAtlasLike,
  type GlyphInkReader,
  type Traversal
} from './terminal-webgl-atlas-sampling'

/**
 * xterm shares one glyph atlas per font/colour config and never rechecks the page pixels behind a cache
 * entry, and reveal keeps the atlas. If a page loses its pixels (an unconfirmed hypothesis for STA-17523),
 * every renderer that uploads it draws blanks. Sample glyph rects that provably held ink and evict the atlas
 * when one reads blank. This does not detect glyphs cached empty or stale per-renderer GPU textures.
 */

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

function trace(entry: {
  trigger: AtlasCheckTrigger
  outcome: string
  reads: number
  page?: number
}): void {
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
