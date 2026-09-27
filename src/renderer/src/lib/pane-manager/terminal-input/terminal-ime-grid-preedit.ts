import type { Terminal } from '@xterm/xterm'

// Orca's xterm patch (config/patches/xterm-src) adds this option; the published typings lack it.
declare module '@xterm/xterm' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- augmentation must merge into xterm's interface
  interface ITerminalOptions {
    /** Draw the IME preedit in the renderer's cell grid instead of xterm's DOM overlay. */
    imePreeditInGrid?: boolean
  }
}

/** Default for terminals Orca creates; the overlay stays available as the instant fallback. */
export const DEFAULT_TERMINAL_IME_PREEDIT_IN_GRID = true

export function resolveTerminalImePreeditInGrid(setting: boolean | undefined): boolean {
  return setting ?? DEFAULT_TERMINAL_IME_PREEDIT_IN_GRID
}

type GridPreeditCompositionHelper = {
  setPreeditHidesTail: (hidesTail: boolean) => void
  setPreeditAnchor: (anchor: { x: number; y: number } | undefined) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGridPreeditCompositionHelper(value: unknown): value is GridPreeditCompositionHelper {
  return (
    isRecord(value) &&
    typeof value.setPreeditHidesTail === 'function' &&
    typeof value.setPreeditAnchor === 'function'
  )
}

function gridPreeditCompositionHelper(terminal: Terminal): GridPreeditCompositionHelper | null {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  const helper: unknown = isRecord(core) ? core._compositionHelper : undefined
  if (!isGridPreeditCompositionHelper(helper)) {
    return null
  }
  return terminal.options.imePreeditInGrid === true ? helper : null
}

/** Whether this terminal draws its IME preedit in the cell grid rather than the overlay. */
export function isTerminalImePreeditInGrid(terminal: Terminal): boolean {
  return gridPreeditCompositionHelper(terminal) !== null
}

/** Hides the row tail the in-grid preedit would push right; a no-op on the overlay path. */
export function setTerminalImePreeditHidesTail(terminal: Terminal, hidesTail: boolean): void {
  gridPreeditCompositionHelper(terminal)?.setPreeditHidesTail(hidesTail)
}

/** Draws the in-grid preedit at a cell other than the cursor; `null` follows the cursor again. */
export function setTerminalImePreeditAnchor(
  terminal: Terminal,
  anchor: { row: number; column: number } | null
): void {
  gridPreeditCompositionHelper(terminal)?.setPreeditAnchor(
    anchor ? { x: anchor.column, y: anchor.row } : undefined
  )
}
