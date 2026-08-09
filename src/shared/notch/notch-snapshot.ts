// Wire shape pushed from main to the notch renderer.
// The renderer holds no derived state: everything it paints is computed in main and arrives
// here whole, so the bar can never disagree with the counts the service resolved.
import type { AgentStatusState } from '../agent-status-types'
import type { CollapsedBarLayout, NotchPresentation } from './notch-bar-geometry'
import type { NotchLane, NotchStatusSummary } from './notch-status-summary'

export const NOTCH_SNAPSHOT_CHANNEL = 'notch:snapshot'
export const NOTCH_ACKNOWLEDGE_CHANNEL = 'notch:panesAcknowledged'
export const NOTCH_SET_EXPANDED_CHANNEL = 'notch:setExpanded'
export const NOTCH_FOCUS_PANE_CHANNEL = 'notch:focusPane'
/** Toggles OS-level click capture; see setNotchInteractive for why this must exist. */
export const NOTCH_SET_INTERACTIVE_CHANNEL = 'notch:setInteractive'
export const NOTCH_REVEAL_PANE_CHANNEL = 'ui:revealNotchPane'
/** Renderer -> main: the reveal listener is attached and buffered reveals can be flushed. */
export const NOTCH_RENDERER_READY_CHANNEL = 'notch:revealRendererReady'

/** Identifies the pane a notch row points at, for both the request and the reveal. */
export type NotchFocusPaneRequest = {
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
}

/** One session as the expanded panel renders it. */
export type NotchRow = {
  paneKey: string
  lane: NotchLane
  state: AgentStatusState
  title: string
  /** Branch or short SHA when known; empty for folder workspaces and main-resolved rows. */
  subtitle: string
  agentType: string | null
  stateStartedAt: number
  worktreeId: string | null
  repoId: string | null
  tabId: string | null
  leafId: string | null
}

/** Everything the collapsed bar needs to paint itself, minus colors (tokens live in CSS). */
export type NotchPaintMetrics = {
  presentation: NotchPresentation
  /** Inset from the screen's top edge to the visible surface; 0 for a hardware notch. */
  topGap: number
  barHeight: number
  notchWidth: number
  cornerStyle: 'hanging-notch' | 'bubble'
  topShoulderRadius: number
  bottomCornerRadius: number
  /** The notch's concave shoulders pull its straight sides inward; content must absorb that. */
  expandedContentSideInset: number
}

export type NotchSnapshot = {
  counts: Record<NotchLane, number>
  layout: CollapsedBarLayout
  metrics: NotchPaintMetrics
  rows: NotchRow[]
  /** Main is the authority: the window is already the matching size when this arrives. */
  expanded: boolean
  /** Bumped every publish so the renderer can drop an out-of-order frame. */
  revision: number
}

export function toNotchSnapshot(
  summary: NotchStatusSummary,
  layout: CollapsedBarLayout,
  metrics: NotchPaintMetrics,
  rows: NotchRow[],
  expanded: boolean,
  revision: number
): NotchSnapshot {
  return { counts: summary.counts, layout, metrics, rows, expanded, revision }
}
