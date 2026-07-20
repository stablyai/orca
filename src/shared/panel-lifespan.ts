/**
 * Panel / canvas terminal lifespan vocabulary.
 *
 * Research: meshina raw/research/2026-07-19-herdr-orca-lifespan-modularity.md
 * (herdr taxonomy imported as naming only — no herdr dependency).
 *
 * Every terminal or browser open path should claim one tier so UI never implies
 * process survival that the runtime does not provide.
 */

/** What survives when a view closes or Orca restarts. */
export type PanelPersistenceTier =
  /** L0 — settings identity: definitions, trees, layout recipes. */
  | 'config'
  /** L1 — view identity: open canvas/page/popout tree + focus. */
  | 'view'
  /** L2 — live process outlives a single mount (park or daemon). */
  | 'process'
  /** L3 — re-exec agent with native session id after death. */
  | 'agent-resume'
  /** L4 — pixel/scrollback without the old process. */
  | 'pixel-history'

/**
 * Process ownership policy for a surface that hosts a PTY or webview guest.
 * - ephemeral: die with the view (popout tiles, one-shot shells/browsers)
 * - parked: keep while the app is up; park when the full-page panel unmounts
 * - daemon: worktree agent sessions only — not used for ops panels
 */
export type TerminalLifespan = 'ephemeral' | 'parked' | 'daemon'

/** Policy A: each canvas/popout leaf mints its own PTY even for the same panelId. */
export const PANEL_CANVAS_PROCESS_POLICY = 'new-process-per-leaf' as const

/** Saved layout open/save claims — never process survival. */
export const PANEL_LAYOUT_PERSISTENCE: readonly PanelPersistenceTier[] = ['config', 'view']

export const PANEL_LAYOUT_RESTORE_HINT =
  'Restores arrangement; terminals and browser tiles will respawn.'

/** Full-page pinned terminal: L0 definition + informal L2 park while app up. */
export const PINNED_TERMINAL_PAGE_LIFESPAN: TerminalLifespan = 'parked'

/** Popout canvas tiles: die with the OS window. */
export const PANEL_POPOUT_TILE_LIFESPAN: TerminalLifespan = 'ephemeral'

/** Ad-hoc shell / blank browser leaves: ephemeral process; L0 only if saved in layout. */
export const PANEL_BLANK_LEAF_LIFESPAN: TerminalLifespan = 'ephemeral'

/** Canvas tile for a pinned panel definition: new process per leaf (policy A). */
export const PANEL_CANVAS_TILE_LIFESPAN: TerminalLifespan = 'ephemeral'
