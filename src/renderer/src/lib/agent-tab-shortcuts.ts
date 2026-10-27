import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'
import {
  agentTabActionId,
  type AgentTabActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import { normalizeDisabledTuiAgents, pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { loadDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { type AgentLaunchRouteStore, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { agentChoiceMayOpenAsChat } from '@/lib/host-chat-program'
import { readAgentLaunchPreferencesForWorktree } from '@/components/settings/use-host-agent-launch-preferences'

export type BoundAgentTabAction = {
  agent: TuiAgent
  actionId: AgentTabActionId
}

/** Offer user-bound per-agent chords only for enabled agents; these actions have no default bindings, and disabled agents leave old bindings inert. */
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

/** Use the enabled/detected or chat-capable default, then auto-pick; blank applies only to workspace creation, so explicit agent chords still launch. */
export function resolveDefaultAgentForNewTab(args: {
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  detectedAgentIds: readonly TuiAgent[] | null | undefined
  disabledTuiAgents: readonly TuiAgent[] | null | undefined
  chatIn?: { store: AgentLaunchRouteStore; worktreeId: string }
}): TuiAgent | null {
  const preferred = args.defaultTuiAgent === 'blank' ? null : args.defaultTuiAgent
  const { chatIn } = args
  const workspace = chatIn && worktreeLaunchWorkspace(chatIn.worktreeId)
  const chosenUsable = (agent: TuiAgent): boolean =>
    !!chatIn &&
    !!workspace &&
    agentChoiceMayOpenAsChat(chatIn.store, agent, workspace, args.detectedAgentIds ?? null)
  return pickTuiAgent(preferred, args.detectedAgentIds ?? [], args.disabledTuiAgents, chosenUsable)
}

export async function resolveDefaultAgentForWorktreeNewTab(
  getState: () => AppState,
  worktreeId: string
): Promise<TuiAgent | null> {
  const { detected: detectedAgentIds } = await acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => loadDetectedAgentsForWorktree(getState(), worktreeId)
  )
  // Why: preferences may change while the host answers; pick with the current ones.
  const state = getState()
  return resolveDefaultAgentForNewTab({
    ...readAgentLaunchPreferencesForWorktree(state, worktreeId),
    detectedAgentIds,
    chatIn: { store: state, worktreeId }
  })
}
