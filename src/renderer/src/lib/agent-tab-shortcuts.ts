import {
  agentTabActionId,
  type AgentTabActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import { normalizeDisabledTuiAgents, pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/types'

export type BoundAgentTabAction = {
  agent: TuiAgent
  actionId: AgentTabActionId
}

/**
 * Agents whose per-agent "new tab" action has at least one user-assigned
 * chord. Per-agent actions ship with no default bindings, so only user
 * overrides can bind them. Disabled agents are skipped so a leftover binding
 * goes inert when the agent is turned off in Settings → Agents.
 */
export function listBoundAgentTabActions(
  keybindings: KeybindingOverrides | undefined,
  disabledTuiAgents: readonly TuiAgent[] | null | undefined
): BoundAgentTabAction[] {
  if (!keybindings) {
    return []
  }
  const disabled = new Set(normalizeDisabledTuiAgents(disabledTuiAgents))
  const bound: BoundAgentTabAction[] = []
  for (const agent of ALL_TUI_AGENTS) {
    if (disabled.has(agent)) {
      continue
    }
    const actionId = agentTabActionId(agent)
    if ((keybindings[actionId] ?? []).length > 0) {
      bound.push({ agent, actionId })
    }
  }
  return bound
}

/**
 * Resolve which agent the `tab.newAgent` chord launches: the configured
 * default agent when it is detected and enabled, otherwise the shared
 * auto-pick order. A 'blank' default means "open new workspaces without an
 * agent" — an explicit new-agent-tab chord still wants an agent, so it falls
 * through to auto-pick instead of doing nothing.
 */
export function resolveDefaultAgentForNewTab(args: {
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  detectedAgentIds: readonly TuiAgent[] | null | undefined
  disabledTuiAgents: readonly TuiAgent[] | null | undefined
}): TuiAgent | null {
  const preferred = args.defaultTuiAgent === 'blank' ? null : args.defaultTuiAgent
  return pickTuiAgent(preferred, args.detectedAgentIds ?? [], args.disabledTuiAgents)
}
