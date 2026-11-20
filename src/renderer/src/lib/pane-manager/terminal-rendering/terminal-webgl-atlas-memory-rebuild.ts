import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import { getVisiblePaneTerminals } from '../pane-manager-registry'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 10_000
// A deferred atlas retries on its own this many times (one per interval), so a frame that closes without more output is still caught.
const DEFERRED_REBUILD_MAX_RETRIES = 6
// Only macOS was measured retaining it (desktop app and Mac browsers); elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

type XtermWebglAddonAtlasInternals = { _renderer?: { _charAtlas?: object } }
type PaneFilter = (pane: ManagedPaneInternal) => boolean
type AtlasRebuilder = (panes: ManagedPaneInternal[], shouldReattach: PaneFilter) => void

let rebuildPanes: AtlasRebuilder | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
// Successful or deferred, attempts stay an interval apart so per-chunk output can't drive repeated scans.
let lastAttemptAt = Number.NEGATIVE_INFINITY
// Per atlas, so one atlas's output never re-arms another; weak so a retired atlas is never kept alive.
const atlasesWithLargePage = new WeakSet<object>()
const atlasesWithOutput = new WeakSet<object>()
const attachedPanes = new Map<object, ManagedPaneInternal>()
const deferredRetries = new WeakMap<object, number>()

function atlasOf(pane: ManagedPaneInternal): object | undefined {
  return (pane.webglAddon as unknown as XtermWebglAddonAtlasInternals | null)?._renderer?._charAtlas
}

/** Wired by the reattach module, which owns detaching and reattaching pane renderers. */
export function setTerminalWebglAtlasRebuilder(rebuilder: AtlasRebuilder): void {
  rebuildPanes = rebuilder
}

/** On screen: window shown, tab shown, and the pane laid out (not an expanded split's hidden sibling). */
function onScreenPaneFilter(): PaneFilter {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return () => false
  }
  const visibleTerminals = getVisiblePaneTerminals()
  return (pane) => visibleTerminals.has(pane.terminal) && pane.container.getClientRects().length > 0
}

function isRebuildDue(atlas: object | undefined): atlas is object {
  return atlas !== undefined && atlasesWithLargePage.has(atlas) && atlasesWithOutput.has(atlas)
}

function rebuildDueAtlases(): void {
  rebuildTimer = null
  const owners = new Map<object, ManagedPaneInternal[]>()
  for (const pane of attachedPanes.values()) {
    const atlas = atlasOf(pane)
    if (!isRebuildDue(atlas)) {
      continue
    }
    const atlasPanes = owners.get(atlas)
    if (atlasPanes) {
      atlasPanes.push(pane)
    } else {
      owners.set(atlas, [pane])
    }
  }
  if (owners.size === 0) {
    return
  }
  lastAttemptAt = Date.now()
  const onScreen = onScreenPaneFilter()
  const panes: ManagedPaneInternal[] = []
  let retry = false
  for (const [atlas, atlasPanes] of owners) {
    // A new canvas paints straight from the buffer, so an on-screen pane mid synchronized-output (DEC 2026) frame would flash it half drawn; that atlas waits.
    if (atlasPanes.some((pane) => onScreen(pane) && pane.terminal.modes.synchronizedOutputMode)) {
      const retries = deferredRetries.get(atlas) ?? 0
      if (retries < DEFERRED_REBUILD_MAX_RETRIES) {
        deferredRetries.set(atlas, retries + 1)
        retry = true
      }
      continue
    }
    // Normally retired by the rebuild; clearing also stops a surviving atlas from rebuilding again without new output.
    atlasesWithLargePage.delete(atlas)
    atlasesWithOutput.delete(atlas)
    deferredRetries.delete(atlas)
    panes.push(...atlasPanes)
  }
  if (retry) {
    scheduleRebuild()
  }
  if (panes.length === 0) {
    return
  }
  recordTerminalWebglDiagnostic('webgl-renderer-rebuild', {
    panes: panes.length,
    reason: 'atlas-memory'
  })
  // Every owner of a due atlas detaches before any reattaches, or a remaining owner keeps it alive; only on-screen owners reattach now.
  rebuildPanes?.(panes, onScreen)
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null) {
    return
  }
  // Also leaves xterm's atlas callback first; the rebuild disposes renderers mid-render.
  const delay = Math.max(0, lastAttemptAt + ATLAS_REBUILD_MIN_INTERVAL_MS - Date.now())
  rebuildTimer = setTimeout(rebuildDueAtlases, delay)
}

/** Tracks an attached WebGL pane for the renderer's lifetime. */
export function trackTerminalWebglAtlasPane(pane: ManagedPaneInternal): void {
  if (ATLAS_MEMORY_REBUILD_ENABLED) {
    attachedPanes.set(pane.terminal, pane)
  }
}

/** Forgets a detached pane so a closed pane is not kept alive. */
export function untrackTerminalWebglAtlasPane(pane: ManagedPaneInternal): void {
  attachedPanes.delete(pane.terminal)
}

/** Marks PTY output for the pane's atlas; repaints, warm-up, reveals and empty parse barriers never come through here. */
export function noteTerminalWebglAtlasOutput(terminal: object): void {
  const pane = attachedPanes.get(terminal)
  const atlas = pane ? atlasOf(pane) : undefined
  if (!atlas) {
    return
  }
  atlasesWithOutput.add(atlas)
  if (isRebuildDue(atlas)) {
    scheduleRebuild()
  }
}

/** Requests a rebuild of the grown atlas's renderers, at most every 10 s and only after PTY output into that atlas. */
export function handleTerminalWebglAtlasPage(
  page: { width: number },
  pane: ManagedPaneInternal
): void {
  // Exact match: the larger oversized-glyph page comes back as soon as its glyph redraws, so a rebuild can't free it.
  if (!ATLAS_MEMORY_REBUILD_ENABLED || page.width !== ATLAS_REBUILD_PAGE_SIZE) {
    return
  }
  const atlas = atlasOf(pane)
  if (!atlas) {
    return
  }
  atlasesWithLargePage.add(atlas)
  if (isRebuildDue(atlas)) {
    scheduleRebuild()
  }
}
