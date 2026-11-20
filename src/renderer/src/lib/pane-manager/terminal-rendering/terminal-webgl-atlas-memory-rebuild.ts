import type { IDisposable } from '@xterm/xterm'
import { rebuildAllTerminalWebglRenderers } from '../pane-manager-registry'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 10_000
// Only macOS was measured retaining it; elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

type OutputSource = { onWriteParsed(listener: () => void): IDisposable }

let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let rebuildRequested = false
let outputSinceRebuild = true
let lastRebuildAt = Number.NEGATIVE_INFINITY
const outputWatchers = new Map<OutputSource, IDisposable>()

function scheduleRebuild(): void {
  if (rebuildTimer !== null || !rebuildRequested || !outputSinceRebuild) {
    return
  }
  // Also leaves xterm's atlas callback first; the rebuild disposes renderers mid-render.
  const delay = Math.max(0, lastRebuildAt + ATLAS_REBUILD_MIN_INTERVAL_MS - Date.now())
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    rebuildRequested = false
    outputSinceRebuild = false
    lastRebuildAt = Date.now()
    rebuildAllTerminalWebglRenderers('atlas-memory')
  }, delay)
}

/** Watches a WebGL terminal's output for its renderer's lifetime; repaints, warm-up and reveals parse nothing, so only output re-arms a rebuild. */
export function watchTerminalWebglAtlasOutput(terminal: OutputSource): void {
  if (!ATLAS_MEMORY_REBUILD_ENABLED || outputWatchers.has(terminal)) {
    return
  }
  outputWatchers.set(
    terminal,
    terminal.onWriteParsed(() => {
      if (!outputSinceRebuild) {
        outputSinceRebuild = true
        scheduleRebuild()
      }
    })
  )
}

/** Drops a detached terminal's watcher so a closed pane is not kept alive. */
export function releaseTerminalWebglAtlasWatcher(terminal: OutputSource): void {
  outputWatchers.get(terminal)?.dispose()
  outputWatchers.delete(terminal)
}

/** Requests one global WebGL rebuild, at most every 10 s and only after output since the last one. */
export function handleTerminalWebglAtlasPage(page: { width: number }): void {
  // Exact match: the larger oversized-glyph page comes back as soon as its glyph redraws, so a rebuild can't free it.
  if (!ATLAS_MEMORY_REBUILD_ENABLED || page.width !== ATLAS_REBUILD_PAGE_SIZE) {
    return
  }
  rebuildRequested = true
  scheduleRebuild()
}
