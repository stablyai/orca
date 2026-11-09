import { acquireAgentLaunchChoices } from '../../../host-chat-program-acquisition'
import { agentTabActionId } from '../../../../../../shared/keybindings/definitions'
import type {
  AgentTabActionId,
  KeybindingOverrides
} from '../../../../../../shared/keybindings/types'
import { ALL_TUI_AGENTS } from '../../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import {
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AppState } from '@/store/types'
import { loadDetectedAgentsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import {
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace,
  worktreeLaunchWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { agentChoiceMayOpenAsChat } from '@/lib/host-chat-program'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'

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
  const { chatIn } = args
  return resolveDefaultAgentForWorkspace({
    ...args,
    defaultTuiAgent: args.defaultTuiAgent === 'blank' ? null : args.defaultTuiAgent,
    chatIn: chatIn && { store: chatIn.store, workspace: worktreeLaunchWorkspace(chatIn.worktreeId) }
  })
}

/** Workspace creation honors blank; a usable preferred chat need not have a detected CLI. */
export function resolveDefaultAgentForWorkspace(args: {
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  detectedAgentIds: readonly TuiAgent[] | null | undefined
  disabledTuiAgents: readonly TuiAgent[] | null | undefined
  chatIn?: { store: AgentLaunchRouteStore; workspace: ProspectiveWorkspace }
}): TuiAgent | null {
  const { chatIn } = args
  const chosenUsable = (agent: TuiAgent): boolean =>
    !!chatIn &&
    agentChoiceMayOpenAsChat(chatIn.store, agent, chatIn.workspace, args.detectedAgentIds ?? null)
  return pickTuiAgent(
    args.defaultTuiAgent,
    args.detectedAgentIds ?? [],
    args.disabledTuiAgents,
    chosenUsable
  )
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

/** Workspace completion honors Blank and resolves against the captured workspace copy. */
export async function resolveDefaultAgentForWorktree(
  getState: () => AppState,
  worktreeId: string
): Promise<TuiAgent | null> {
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const [{ detected: detectedAgentIds }, preferences] = await Promise.all([
    acquireAgentLaunchChoices(
      workspace,
      () => loadDetectedAgentsForWorktree(getState(), worktreeId),
      undefined,
      false,
      getState
    ),
    ensureAgentLaunchPreferences(getState(), workspace)
  ])
  return resolveDefaultAgentForWorkspace({
    ...preferences,
    detectedAgentIds,
    chatIn: { store: getState(), workspace }
  })
}
