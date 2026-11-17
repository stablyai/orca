import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../agent-launch/catalog/tui-agent-config'
import { normalizeDisabledTuiAgents } from '../agent-launch/catalog/tui-agent-selection'

/** The node only runs these agents; the rest of the catalog stays installed but hidden. */
export const ZOTZ_VISIBLE_TUI_AGENTS: readonly TuiAgent[] = ['claude', 'codex', 'antigravity']

declare global {
  // Global so upstream suites that reset modules keep testing Orca's full agent catalog.
  var zotzAllTuiAgentsVisibleForTests: boolean | undefined
}

export function _setZotzAllTuiAgentsVisibleForTests(visible: boolean): void {
  globalThis.zotzAllTuiAgentsVisibleForTests = visible
}

/**
 * Hides every catalog agent Zotz has not seen yet unless it is one of the visible three, so
 * agents added by an upstream sync start hidden while the user's own toggles are kept.
 */
export function applyZotzVisibleAgents(
  disabledTuiAgents: unknown,
  zotzSeenTuiAgents: unknown
): { disabledTuiAgents: TuiAgent[]; zotzSeenTuiAgents?: TuiAgent[] } {
  const disabled = normalizeDisabledTuiAgents(disabledTuiAgents)
  if (globalThis.zotzAllTuiAgentsVisibleForTests === true) {
    return { disabledTuiAgents: disabled }
  }
  const seen = new Set(normalizeDisabledTuiAgents(zotzSeenTuiAgents))
  const catalog = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
  for (const agent of catalog) {
    if (!seen.has(agent) && !ZOTZ_VISIBLE_TUI_AGENTS.includes(agent) && !disabled.includes(agent)) {
      disabled.push(agent)
    }
  }
  return { disabledTuiAgents: disabled, zotzSeenTuiAgents: catalog }
}
