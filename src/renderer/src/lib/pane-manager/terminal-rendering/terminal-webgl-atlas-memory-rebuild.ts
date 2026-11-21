import type { ManagedPaneInternal } from '../pane-manager-types'
import type { ForegroundTerminalOutputTarget } from '../terminal-output/pane-terminal-foreground-render-settle'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { isElementInVisiblePaneManager } from '../pane-manager-registry'
import { getWindowParkVisible } from '../../window-activity/window-park-visibility'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 60_000
// A rebuild recreates every context in its atlas over ~0.5-2 s, so it waits for output into that atlas to pause and for typing to stop.
const ATLAS_REBUILD_QUIET_MS = 2_000
// Output that never pauses would retain GPU memory without bound; past this, typing alone holds the rebuild.
const ATLAS_REBUILD_MAX_QUIET_WAIT_MS = 60_000
// An overdue atlas blocked by an on-screen synchronized-output frame looks again this soon, to land between frames.
const ATLAS_REBUILD_FRAME_RETRY_MS = 250
// Only macOS was measured retaining it (desktop app and Mac browsers); elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

// xterm's shared TextureAtlas, read from the addon's private renderer; only its identity is used.
type GlyphAtlas = { readonly pages: readonly unknown[] }
type PaneFilter = (pane: ManagedPaneInternal) => boolean
/** Rechecked on each pane's own frame: 'skip' leaves it detached until reveal, 'wait' holds it a frame. */
export type DeferredReattachVerdict = 'now' | 'wait' | 'skip'
type AtlasRebuilder = (
  panes: ManagedPaneInternal[],
  shouldReattach: PaneFilter,
  verdictOnItsFrame: (pane: ManagedPaneInternal) => DeferredReattachVerdict
) => void

let rebuildPanes: AtlasRebuilder | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
// Successful or deferred, attempts stay an interval apart so per-chunk output can't drive repeated scans.
let lastAttemptAt = Number.NEGATIVE_INFINITY
let lastTypedAt = Number.NEGATIVE_INFINITY
// Per atlas, so one atlas's output never re-arms another; weak so a retired atlas is never kept alive.
const atlasesWithLargePage = new WeakSet<GlyphAtlas>()
const atlasesWithOutput = new WeakSet<GlyphAtlas>()
const lastOutputAt = new WeakMap<GlyphAtlas, number>()
const dueSince = new WeakMap<GlyphAtlas, number>()
const frameRetryAt = new WeakMap<GlyphAtlas, number>()
const attachedPanes = new Map<unknown, ManagedPaneInternal>()
// Owners indexed per atlas, so an attempt visits only the due atlases' panes, never every terminal.
const atlasOwners = new WeakMap<GlyphAtlas, Set<ManagedPaneInternal>>()
const paneAtlases = new WeakMap<ManagedPaneInternal, GlyphAtlas>()
// Strong only until rebuilt or ownerless.
const dueAtlases = new Set<GlyphAtlas>()
// Chat-covered panes a rebuild left detached; the cover's unmount gives them WebGL back.
const coveredDetachedPanes = new WeakMap<ManagedPaneInternal['terminal'], ManagedPaneInternal>()

function atlasOf(pane: ManagedPaneInternal): GlyphAtlas | undefined {
  const addon = pane.webglAddon
  if (!addon || !('_renderer' in addon)) {
    return undefined
  }
  const renderer = addon._renderer
  if (typeof renderer !== 'object' || renderer === null || !('_charAtlas' in renderer)) {
    return undefined
  }
  return isGlyphAtlas(renderer._charAtlas) ? renderer._charAtlas : undefined
}

function isGlyphAtlas(value: unknown): value is GlyphAtlas {
  return (
    typeof value === 'object' && value !== null && 'pages' in value && Array.isArray(value.pages)
  )
}

function forgetOwner(pane: ManagedPaneInternal): void {
  const previous = paneAtlases.get(pane)
  if (!previous) {
    return
  }
  paneAtlases.delete(pane)
  const owners = atlasOwners.get(previous)
  owners?.delete(pane)
  if (!owners?.size) {
    forgetDue(previous)
  }
}

/** Files the pane under its current atlas; xterm swaps atlases on font or theme changes. */
function indexOwner(pane: ManagedPaneInternal): GlyphAtlas | undefined {
  const atlas = atlasOf(pane)
  if (paneAtlases.get(pane) === atlas) {
    return atlas
  }
  forgetOwner(pane)
  if (!atlas) {
    return undefined
  }
  paneAtlases.set(pane, atlas)
  const owners = atlasOwners.get(atlas)
  if (owners) {
    owners.add(pane)
  } else {
    atlasOwners.set(atlas, new Set([pane]))
  }
  return atlas
}

function markIfDue(atlas: GlyphAtlas): void {
  if (atlasesWithLargePage.has(atlas) && atlasesWithOutput.has(atlas)) {
    if (!dueAtlases.has(atlas)) {
      dueSince.set(atlas, performance.now())
    }
    dueAtlases.add(atlas)
    scheduleRebuild()
  }
}

/** When the atlas may rebuild: its output paused and typing stopped (or, once overdue, typing stopped). */
function readyAt(atlas: GlyphAtlas): number {
  const typingClear = lastTypedAt + ATLAS_REBUILD_QUIET_MS
  const quiet = (lastOutputAt.get(atlas) ?? Number.NEGATIVE_INFINITY) + ATLAS_REBUILD_QUIET_MS
  const overdue = (dueSince.get(atlas) ?? 0) + ATLAS_REBUILD_MAX_QUIET_WAIT_MS
  const frameRetry = frameRetryAt.get(atlas) ?? Number.NEGATIVE_INFINITY
  return Math.max(typingClear, frameRetry, Math.min(quiet, overdue))
}

function forgetDue(atlas: GlyphAtlas): void {
  dueAtlases.delete(atlas)
  dueSince.delete(atlas)
  frameRetryAt.delete(atlas)
}

/** Wired by the reattach module, which owns detaching and reattaching pane renderers. */
export function setTerminalWebglAtlasRebuilder(rebuilder: AtlasRebuilder): void {
  rebuildPanes = rebuilder
}

/** Shown: window shown, tab shown, and the pane laid out (not an expanded split's hidden sibling). */
function shownPaneFilter(): PaneFilter {
  if (!getWindowParkVisible()) {
    return () => false
  }
  return (pane) =>
    isElementInVisiblePaneManager(pane.container) && pane.container.getClientRects().length > 0
}

/** A pane hidden, covered or mid synchronized-output frame since the rebuild must not get its context yet. */
function deferredReattachVerdict(pane: ManagedPaneInternal): DeferredReattachVerdict {
  if (!shownPaneFilter()(pane)) {
    return 'skip'
  }
  if (paneIsCoveredByNativeChat(pane)) {
    coveredDetachedPanes.set(pane.terminal, pane)
    return 'skip'
  }
  return pane.terminal.modes.synchronizedOutputMode ? 'wait' : 'now'
}

function rebuildDueAtlases(): void {
  rebuildTimer = null
  if (dueAtlases.size === 0) {
    return
  }
  const now = performance.now()
  const ready = [...dueAtlases].filter((atlas) => readyAt(atlas) <= now)
  if (ready.length === 0) {
    scheduleRebuild()
    return
  }
  const shown = shownPaneFilter()
  const onScreen: PaneFilter = (pane) => shown(pane) && !paneIsCoveredByNativeChat(pane)
  const panes: ManagedPaneInternal[] = []
  let retry = false
  let attempted = false
  for (const atlas of ready) {
    const atlasPanes = [...(atlasOwners.get(atlas) ?? [])].filter(
      (pane) => attachedPanes.get(pane.terminal) === pane && atlasOf(pane) === atlas
    )
    // A new canvas paints straight from the buffer, and xterm holds the DOM renderer's paint until a synchronized-output (DEC 2026) frame closes, so an on-screen pane mid-frame would go blank or half drawn; that atlas waits.
    if (atlasPanes.some((pane) => onScreen(pane) && pane.terminal.modes.synchronizedOutputMode)) {
      retry = true
      if (now - (dueSince.get(atlas) ?? now) >= ATLAS_REBUILD_MAX_QUIET_WAIT_MS) {
        // Overdue: look again soon, so a TUI that keeps reopening frames is caught between two of them.
        frameRetryAt.set(atlas, now + ATLAS_REBUILD_FRAME_RETRY_MS)
      } else {
        // Counts as an attempt; the next one is overdue and retries between frames.
        attempted = true
      }
      continue
    }
    attempted = true
    // Normally retired by the rebuild; clearing also stops a surviving atlas from rebuilding again without new output.
    forgetDue(atlas)
    atlasesWithLargePage.delete(atlas)
    atlasesWithOutput.delete(atlas)
    panes.push(...atlasPanes)
  }
  if (attempted) {
    lastAttemptAt = now
  }
  if (retry || dueAtlases.size > 0) {
    scheduleRebuild()
  }
  if (panes.length === 0) {
    return
  }
  // Decided before any detach: detaching changes layout, and reading rects afterwards forces one layout per pane.
  const reattach = new Set<ManagedPaneInternal>()
  for (const pane of panes) {
    if (!shown(pane)) {
      continue
    }
    if (paneIsCoveredByNativeChat(pane)) {
      coveredDetachedPanes.set(pane.terminal, pane)
    } else {
      reattach.add(pane)
    }
  }
  // Every owner of a due atlas detaches before any reattaches, or a remaining owner keeps it alive; only on-screen owners reattach now.
  const startedAt = performance.now()
  rebuildPanes?.(panes, (pane) => reattach.has(pane), deferredReattachVerdict)
  recordTerminalWebglDiagnostic('webgl-renderer-rebuild', {
    panes: panes.length,
    reattached: reattach.size,
    reason: 'atlas-memory',
    durationMs: Math.round(performance.now() - startedAt)
  })
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null) {
    return
  }
  // One timer, set to the earliest due atlas; output arriving later just moves that atlas's time, checked when the timer fires.
  let at = Number.POSITIVE_INFINITY
  for (const atlas of dueAtlases) {
    at = Math.min(at, readyAt(atlas))
  }
  // Also leaves xterm's atlas callback first; the rebuild disposes renderers mid-render.
  const delay = Math.max(
    0,
    lastAttemptAt + ATLAS_REBUILD_MIN_INTERVAL_MS - performance.now(),
    at - performance.now()
  )
  rebuildTimer = setTimeout(rebuildDueAtlases, delay)
}

/** Tracks an attached WebGL pane for the renderer's lifetime. */
export function trackTerminalWebglAtlasPane(pane: ManagedPaneInternal): void {
  coveredDetachedPanes.delete(pane.terminal)
  if (ATLAS_MEMORY_REBUILD_ENABLED) {
    attachedPanes.set(pane.terminal, pane)
    indexOwner(pane)
  }
}

/** The pane a rebuild left detached under this chat cover, if it is still shown and should get WebGL back now. */
export function takeCoveredDetachedPane(
  terminal: ManagedPaneInternal['terminal']
): ManagedPaneInternal | undefined {
  const pane = coveredDetachedPanes.get(terminal)
  coveredDetachedPanes.delete(terminal)
  return pane && shownPaneFilter()(pane) ? pane : undefined
}

/** Forgets a detached pane so a closed pane is not kept alive. */
export function untrackTerminalWebglAtlasPane(pane: ManagedPaneInternal): void {
  attachedPanes.delete(pane.terminal)
  forgetOwner(pane)
}

/** Re-files a pane whose renderer swapped atlases (font, zoom or theme change), so a rebuild reaches every owner. */
export function noteTerminalWebglAtlasChange(pane: ManagedPaneInternal): void {
  // xterm fires this before it assigns the new atlas.
  queueMicrotask(() => {
    if (attachedPanes.get(pane.terminal) === pane) {
      indexOwner(pane)
    }
  })
}

/** Marks PTY output for the pane's atlas; repaints, warm-up, reveals and empty parse barriers never come through here. */
export function noteTerminalWebglAtlasOutput(terminal: ForegroundTerminalOutputTarget): void {
  const pane = attachedPanes.get(terminal)
  const atlas = pane ? indexOwner(pane) : undefined
  if (!atlas) {
    return
  }
  atlasesWithOutput.add(atlas)
  lastOutputAt.set(atlas, performance.now())
  markIfDue(atlas)
}

/** User input sent to any terminal; holds atlas rebuilds so none lands between keystrokes. */
export function noteTerminalWebglAtlasTyping(): void {
  lastTypedAt = performance.now()
}

/** Requests a rebuild of the grown atlas's renderers, at most every 60 s, only after PTY output into that atlas, once it pauses. */
export function handleTerminalWebglAtlasPage(
  page: { width: number },
  pane: ManagedPaneInternal
): void {
  if (!ATLAS_MEMORY_REBUILD_ENABLED || attachedPanes.get(pane.terminal) !== pane) {
    return
  }
  // xterm forwards every page event to each renderer sharing the atlas, so this also completes the owner index.
  const atlas = indexOwner(pane)
  // Exact match: the larger oversized-glyph page comes back as soon as its glyph redraws, so a rebuild can't free it.
  if (!atlas || page.width !== ATLAS_REBUILD_PAGE_SIZE) {
    return
  }
  atlasesWithLargePage.add(atlas)
  markIfDue(atlas)
}
