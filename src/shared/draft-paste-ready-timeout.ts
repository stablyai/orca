import type { CustomTuiAgent, DeletedCustomTuiAgent, TuiAgent } from './tui-agent'
import { resolveTuiAgentConfig } from './custom-tui-agents'

const DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS = 8000

/** Per-agent readiness budgets live in the built-in-only registry, so a custom id
 *  resolves through its base harness via the catalog. Without the catalog a
 *  custom id safely falls back to the default budget instead of crashing on an
 *  undefined registry row. */
export function resolveDraftPasteReadyTimeoutMs(
  agent?: TuiAgent,
  overrideMs?: number,
  customTuiAgents?: readonly CustomTuiAgent[] | null,
  deletedCustomTuiAgents?: readonly DeletedCustomTuiAgent[] | null
): number {
  return (
    overrideMs ??
    resolveTuiAgentConfig(agent, customTuiAgents, deletedCustomTuiAgents)
      ?.draftPasteReadyTimeoutMs ??
    DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS
  )
}
