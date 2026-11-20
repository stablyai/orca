import type { ManagedPaneInternal } from '../pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../../shared/terminal/diagnostics/terminal-webgl-diagnostics'
import {
  getVisiblePaneTerminals,
  rebuildTerminalWebglRenderersForPanes
} from '../pane-manager-registry'

// A 4096² merged page means the shared atlas reached ~64 MiB; on Apple GPUs each context keeps its upload memory until the context is destroyed (GiBs across panes).
const ATLAS_REBUILD_PAGE_SIZE = 4096
const ATLAS_REBUILD_MIN_INTERVAL_MS = 10_000
// Only macOS was measured retaining it (desktop app and Mac browsers); elsewhere a mass context recreate risks the driver's context budget. Touch excludes iPadOS desktop-mode agents.
const ATLAS_MEMORY_REBUILD_ENABLED =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  !(navigator.maxTouchPoints > 0)

type XtermWebglAddonAtlasInternals = { _renderer?: { _charAtlas?: object } }

let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let lastRebuildAt = Number.NEGATIVE_INFINITY
// Per atlas, so one atlas's output never re-arms another; weak so a retired atlas is never kept alive.
const atlasesWithLargePage = new WeakSet<object>()
const atlasesWithOutput = new WeakSet<object>()
const attachedPanes = new Map<object, ManagedPaneInternal>()

function atlasOf(pane: ManagedPaneInternal): object | undefined {
  return (pane.webglAddon as unknown as XtermWebglAddonAtlasInternals | null)?._renderer?._charAtlas
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
  // A new canvas paints straight from the buffer, so a visible pane mid synchronized-output (DEC 2026) frame would flash it half drawn; that atlas waits for its next output.
  const visibleTerminals = getVisiblePaneTerminals()
  const panes = new Set<ManagedPaneInternal>()
  for (const [atlas, atlasPanes] of owners) {
    if (
      atlasPanes.some(
        (pane) => visibleTerminals.has(pane.terminal) && pane.terminal.modes.synchronizedOutputMode
      )
    ) {
      continue
    }
    // Normally retired by the rebuild; clearing also stops a surviving atlas from rebuilding again without new output.
    atlasesWithLargePage.delete(atlas)
    atlasesWithOutput.delete(atlas)
    for (const pane of atlasPanes) {
      panes.add(pane)
    }
  }
  if (panes.size === 0) {
    return
  }
  lastRebuildAt = Date.now()
  recordTerminalWebglDiagnostic('webgl-renderer-rebuild', {
    panes: panes.size,
    reason: 'atlas-memory'
  })
  // Every owner of a due atlas detaches together, or a remaining owner keeps it alive; other atlases' renderers are untouched.
  rebuildTerminalWebglRenderersForPanes(panes)
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
