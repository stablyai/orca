import type { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane) => void | Promise<void>
  onPaneClosed?: (paneId: number) => void
  onActivePaneChange?: (pane: ManagedPane, reason: ActivePaneChangeReason) => void
  onLayoutChanged?: () => void
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
}

export type ActivePaneChangeReason =
  | 'pointer'
  | 'hover'
  | 'keyboard'
  | 'expand'
  | 'restore'
  | 'programmatic'

export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
  // Why this behavior flag lives on "style" options: this type is already
  // the single runtime-settings bag the PaneManager exposes. Splitting into
  // separate style vs behavior types is a refactor worth its own change
  // when a second behavior flag lands. See docs/focus-follows-mouse-design.md.
  focusFollowsMouse?: boolean
}

export type ManagedPane = {
  id: number
  terminal: Terminal
  container: HTMLElement // the .pane element
  linkTooltip: HTMLElement
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  gpuRenderingEnabled: boolean
  webglAddon: WebglAddon | null
  serializeAddon: SerializeAddon
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
