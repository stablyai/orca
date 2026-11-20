import type { IDisposable } from '@xterm/xterm'
import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 10_000
// A rebuild repaints from the buffer, so wait out a synchronized-output (DEC 2026) frame instead of exposing it half drawn.
const SYNCHRONIZED_FRAME_RETRY_MS = 250
// Only macOS was measured retaining it (desktop app and Mac browsers); elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

type AtlasRebuilder = (panes: ManagedPaneInternal[]) => void
type XtermWebglAddonAtlasInternals = { _renderer?: { _charAtlas?: object } }

let rebuildPanes: AtlasRebuilder | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
// Weak so an atlas retired by other means is never kept alive while no output arrives.
let requestedAtlases = new WeakSet<object>()
let rebuildRequested = false
let outputSinceRebuild = true
let lastRebuildAt = Number.NEGATIVE_INFINITY
const outputWatchers = new Map<ManagedPaneInternal, IDisposable>()

function atlasOf(pane: ManagedPaneInternal): object | undefined {
  return (pane.webglAddon as unknown as XtermWebglAddonAtlasInternals | null)?._renderer?._charAtlas
}

/** Wired by the reattach module, which owns detaching and reattaching pane renderers. */
export function setTerminalWebglAtlasRebuilder(rebuilder: AtlasRebuilder): void {
  rebuildPanes = rebuilder
}

function rebuildRequestedAtlases(): void {
  rebuildTimer = null
  // Every owner of the grown atlas must detach together, or a remaining owner keeps it alive; other atlases' renderers are untouched.
  const panes = [...outputWatchers.keys()].filter((pane) => {
    const atlas = atlasOf(pane)
    return atlas !== undefined && requestedAtlases.has(atlas)
  })
  if (panes.some((pane) => pane.terminal.modes.synchronizedOutputMode)) {
    rebuildTimer = setTimeout(rebuildRequestedAtlases, SYNCHRONIZED_FRAME_RETRY_MS)
    return
  }
  requestedAtlases = new WeakSet()
  rebuildRequested = false
  outputSinceRebuild = false
  lastRebuildAt = Date.now()
  if (panes.length === 0) {
    return
  }
  recordTerminalWebglDiagnostic('webgl-renderer-rebuild', {
    panes: panes.length,
    reason: 'atlas-memory'
  })
  rebuildPanes?.(panes)
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null || !rebuildRequested || !outputSinceRebuild) {
    return
  }
  // Also leaves xterm's atlas callback first; the rebuild disposes renderers mid-render.
  const delay = Math.max(0, lastRebuildAt + ATLAS_REBUILD_MIN_INTERVAL_MS - Date.now())
  rebuildTimer = setTimeout(rebuildRequestedAtlases, delay)
}

/** Watches an attached WebGL pane for the renderer's lifetime. Only parsed output moves the cursor; repaints, warm-up, reveals and empty parse barriers don't. */
export function watchTerminalWebglAtlasOutput(pane: ManagedPaneInternal): void {
  if (!ATLAS_MEMORY_REBUILD_ENABLED || outputWatchers.has(pane)) {
    return
  }
  outputWatchers.set(
    pane,
    pane.terminal.onCursorMove(() => {
      if (!outputSinceRebuild) {
        outputSinceRebuild = true
        scheduleRebuild()
      }
    })
  )
}

/** Drops a detached pane's watcher so a closed pane is not kept alive. */
export function releaseTerminalWebglAtlasWatcher(pane: ManagedPaneInternal): void {
  outputWatchers.get(pane)?.dispose()
  outputWatchers.delete(pane)
}

/** Requests a rebuild of the grown atlas's renderers, at most every 10 s and only after output since the last one. */
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
  requestedAtlases.add(atlas)
  rebuildRequested = true
  scheduleRebuild()
}
