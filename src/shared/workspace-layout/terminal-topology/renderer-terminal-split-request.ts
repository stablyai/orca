import type { TerminalPaneSplitSource } from '../../feature-education/feature-education-telemetry'

/** One-shot launch request for splits owned by the window. */
export type RendererTerminalSplitRequest = {
  tabId: string
  paneRuntimeId: number
  direction: 'horizontal' | 'vertical'
  command?: string
  env?: Record<string, string>
  worktreeId?: string
  sourceLeafId?: string
  telemetrySource?: TerminalPaneSplitSource
  newLeafId?: string
  /** An agent's split leaves the user's active pane and keyboard focus alone. */
  activate?: false
}
