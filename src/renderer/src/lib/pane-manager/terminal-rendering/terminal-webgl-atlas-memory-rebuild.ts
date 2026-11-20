import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 10_000
// A rebuild repaints from the buffer, so wait out a synchronized-output (DEC 2026) frame; cap it like xterm's own 1 s sync timeout, which paused panes never arm.
const SYNCHRONIZED_FRAME_RETRY_MS = 250
const SYNCHRONIZED_FRAME_MAX_RETRIES = 4
// Only macOS was measured retaining it (desktop app and Mac browsers); elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

type AtlasRebuilder = (panes: ManagedPaneInternal[]) => void
type XtermWebglAddonAtlasInternals = { _renderer?: { _charAtlas?: object } }

let rebuildPanes: AtlasRebuilder | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let synchronizedFrameRetries = 0
let lastRebuildAt = Number.NEGATIVE_INFINITY
// Per atlas, so one atlas's output never re-arms another; weak so a retired atlas is never kept alive. A rebuild retires the atlas, so its successor starts clean.
const atlasesWithLargePage = new WeakSet<object>()
const atlasesWithOutput = new WeakSet<object>()
const attachedPanes = new Map<object, ManagedPaneInternal>()

function atlasOf(pane: ManagedPaneInternal): object | undefined {
  return (pane.webglAddon as unknown as XtermWebglAddonAtlasInternals | null)?._renderer?._charAtlas
}

function isRebuildDue(atlas: object | undefined): atlas is object {
  return atlas !== undefined && atlasesWithLargePage.has(atlas) && atlasesWithOutput.has(atlas)
}

/** Wired by the reattach module, which owns detaching and reattaching pane renderers. */
export function setTerminalWebglAtlasRebuilder(rebuilder: AtlasRebuilder): void {
  rebuildPanes = rebuilder
}

function rebuildDueAtlases(): void {
  rebuildTimer = null
  // Every owner of a due atlas detaches together, or a remaining owner keeps it alive; other atlases' renderers are untouched.
  const panes = [...attachedPanes.values()].filter((pane) => isRebuildDue(atlasOf(pane)))
  if (panes.length === 0) {
    synchronizedFrameRetries = 0
    return
  }
  if (
    synchronizedFrameRetries < SYNCHRONIZED_FRAME_MAX_RETRIES &&
    panes.some((pane) => pane.terminal.modes.synchronizedOutputMode)
  ) {
    synchronizedFrameRetries++
    rebuildTimer = setTimeout(rebuildDueAtlases, SYNCHRONIZED_FRAME_RETRY_MS)
    return
  }
  synchronizedFrameRetries = 0
  lastRebuildAt = Date.now()
  // Normally retired by the rebuild; clearing also stops a surviving atlas from rebuilding again without new output.
  for (const pane of panes) {
    const atlas = atlasOf(pane)
    if (atlas) {
      atlasesWithLargePage.delete(atlas)
      atlasesWithOutput.delete(atlas)
    }
  }
  recordTerminalWebglDiagnostic('webgl-renderer-rebuild', {
    panes: panes.length,
    reason: 'atlas-memory'
  })
  rebuildPanes?.(panes)
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null) {
    return
  }
  // Also leaves xterm's atlas callback first; the rebuild disposes renderers mid-render.
  const delay = Math.max(0, lastRebuildAt + ATLAS_REBUILD_MIN_INTERVAL_MS - Date.now())
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
