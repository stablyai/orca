import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS = 8000

export function resolveDraftPasteReadyTimeoutMs(agent?: TuiAgent, overrideMs?: number): number {
  return (
    overrideMs ??
    (agent ? TUI_AGENT_CONFIG[agent].draftPasteReadyTimeoutMs : undefined) ??
    DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS
  )
}
