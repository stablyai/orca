import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { PreviewBoxFitAxis } from './preview-terminal-box-fit'

export type AgentTerminalPreviewProps = {
  ptyId: string
  /** Host-input facts relayed with the card; null routes bytes by client OS. */
  terminalInput?: DashboardCardTerminalInput | null
  /** Optional font size override (e.g. for grid session cards). */
  fontSize?: number
  /** Axes the scale-to-fit fallback may shrink on. Grid cards need 'both'. */
  fitAxis?: PreviewBoxFitAxis
  /** Focus the terminal on its first replay. Off for grids, where N previews would fight. */
  autoFocus?: boolean
  /** Filled with a focus callback so a surrounding card can hand over the keyboard. */
  focusRef?: React.MutableRefObject<(() => void) | null>
  /** Release with the next batch instead of at once; for surfaces that mount many previews. */
  detachBatched?: boolean
  /** Fired once main reports it knows no such pty; a host that can respawn the pane reacts here. */
  onPtyGone?: () => void
  className?: string
}
