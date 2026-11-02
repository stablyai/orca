import { pickTuiAgent } from '../../../shared/tui-agent-selection'
import { newAgentLaunchesMayOpenChats } from '@/runtime/local-structured-chats'
import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  ensureDetectedAgentsForTarget,
  readDetectedAgentsForTarget
} from '@/lib/agent-detection-target-inventory'
import { workspaceKindForWorktreeId, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { chosenAgentChatUnlearned, agentChoiceOpensAsChat } from '@/lib/host-chat-program'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import {
  readAgentLaunchPreferencesForWorktree,
  type AgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'

type DefaultChatHost = { target: AgentDetectionTarget; preferences: AgentLaunchPreferences }

/** Share the host between wait/open; undefined means the workspace opens a shell regardless of agent inventory. */
function defaultChatHost(state: AppState, worktreeId: string): DefaultChatHost | undefined {
  // Why the owner's copy: a paired host keeps its own default agent.
  const preferences = readAgentLaunchPreferencesForWorktree(state, worktreeId)
  const chosen = preferences.defaultTuiAgent
  // Why: only a saved agent asks for a chat here; Auto must not turn catalog order into a launch (#36594).
  if (!chosen || chosen === 'blank' || !newAgentLaunchesMayOpenChats(state.settings)) {
    return undefined
  }
  // Why: an unresolved owner is an unknown host, not the local machine.
  const target = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  )
  return target && { target, preferences }
}

export function emptyWorkspaceDefaultChatAwaitsDetection(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const host = defaultChatHost(state, worktreeId)
  const detected = host && readDetectedAgentsForTarget(state, host.target)
  const workspace = worktreeLaunchWorkspace(worktreeId)
  return (
    detected === null ||
    (!!detected &&
      chosenAgentChatUnlearned(state, host?.preferences.defaultTuiAgent, detected, workspace))
  )
}

export async function loadEmptyWorkspaceDefaultChatDetection(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const host = defaultChatHost(state, worktreeId)
  if (!host) {
    return
  }
  await acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => ensureDetectedAgentsForTarget(state, host.target),
    undefined,
    true
  ).catch(() => undefined)
}

/** Open the configured default chat for an empty workspace; null or host decline seeds a shell, never an unrequested agent TUI. */
export function openDefaultAgentChatInEmptyWorkspace(
  worktreeId: string,
  seedShell: () => boolean
): { primaryTabId: string | null } | null {
  const state = useAppStore.getState()
  const host = defaultChatHost(state, worktreeId)
  if (!host) {
    return null
  }
  const detected = readDetectedAgentsForTarget(state, host.target)
  const agent = pickTuiAgent(
    host.preferences.defaultTuiAgent,
    detected ?? [],
    host.preferences.disabledTuiAgents,
    (chosen) => agentChoiceOpensAsChat(state, chosen, worktreeLaunchWorkspace(worktreeId), detected)
  )
  if (!agent) {
    return null
  }
  // No user gesture: opening this empty workspace is the one action this chat serves.
  const agentSessionLaunchPlan = planAgentSessionLaunch(state, {
    requestId: newAgentLaunchRequestId(),
    agent,
    workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  })
  // Why: an agent that can only open as a TUI here would replace the shell with a process nobody asked for.
  if (agentSessionLaunchPlan.route === 'terminal-tui') {
    return null
  }
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    launchSource: 'unknown',
    agentSessionLaunchPlan,
    pendingActivationSpawn: true,
    onStructuredHostDeclined: () => ({ opened: seedShell() })
  })
  if (!result) {
    return null
  }
  return { primaryTabId: result.surface.kind === 'host-published' ? null : result.surface.tabId }
}
