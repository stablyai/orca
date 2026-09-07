import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveCanonicalPaneAgentIdentity,
  type ForegroundProcessProof
} from '../../../../shared/pane-agent-identity-adapter'
import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'

export type NativeChatLeafTitlePane = {
  id: number
  leafId: string
}

export type NativeChatLeafTitleAgentInput = {
  leafId: string | null
  panes: readonly NativeChatLeafTitlePane[]
  runtimePaneTitlesByPaneId: Readonly<Record<number, string>>
  tabLabel?: string | null
  terminalTitle?: string | null
  /** Optional pane-scoped evidence for callers that already hold it. */
  hookAgent?: TuiAgent | null
  completedHookAgent?: TuiAgent | null
  launchAgent?: TuiAgent | null
  sleepingSessionAgent?: TuiAgent | null
  siblingAgent?: TuiAgent | null
  processAgent?: TuiAgent | null
  processProof?: ForegroundProcessProof | null
}

export function resolveNativeChatLeafTitleAgent({
  leafId,
  panes,
  runtimePaneTitlesByPaneId,
  tabLabel,
  terminalTitle,
  hookAgent,
  completedHookAgent,
  launchAgent,
  sleepingSessionAgent,
  siblingAgent,
  processAgent,
  processProof
}: NativeChatLeafTitleAgentInput): TuiAgent | null {
  if (!leafId) {
    return null
  }
  const targetPane = panes.find((pane) => pane.leafId === leafId)
  const paneTitle = targetPane ? (runtimePaneTitlesByPaneId[targetPane.id] ?? '') : null
  // Tab titles can lag pane focus, so only a single-leaf tab may use that fallback.
  const title = paneTitle?.trim()
    ? paneTitle
    : panes.length > 1
      ? null
      : (tabLabel ?? terminalTitle ?? null)
  const resolved = resolveCanonicalPaneAgentIdentity({
    hookAgent,
    hookIsLive: true,
    completedHookAgent,
    launchAgent,
    processProof,
    foregroundAgent: processAgent,
    sleepingSessionAgent,
    siblingAgent,
    allowSibling: siblingAgent != null,
    title,
    uncoveredFallback: {
      agent: title ? resolveExplicitTerminalTitleAgentType(title) : null,
      titleOnly: true
    }
  })
  return resolved.agent
}
