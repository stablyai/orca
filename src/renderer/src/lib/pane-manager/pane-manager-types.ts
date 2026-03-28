import type { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane) => void | Promise<void>
  onPaneClosed?: (paneId: number) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
}

export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
}

export type ManagedPane = {
  id: number
  terminal: Terminal
  container: HTMLElement // the .pane element
  fitAddon: FitAddon
  searchAddon: SearchAddon
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  webglAddon: WebglAddon | null
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
