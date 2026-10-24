import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'
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

/**
 * The host whose agent list picks the default chat; undefined when the workspace opens a shell
 * whatever that list says. Shared by the wait and the open so they cannot drift.
 */
function defaultChatDetectionTarget(
  state: AppState,
  worktreeId: string
): AgentDetectionTarget | undefined {
  // Why: a 'blank' default means the user wants workspaces to open without an agent.
  if (!isNativeChatEnabled(state.settings) || state.settings?.defaultTuiAgent === 'blank') {
    return undefined
  }
  // Why: an unresolved owner is an unknown host, not the local machine.
  return parseAgentDetectionTargetKey(getAgentDetectionTargetKeyForWorktree(state, worktreeId))
}

/** True when the default chat could open here but its agent list or chat facts have not loaded. */
export function emptyWorkspaceDefaultChatAwaitsDetection(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  const detected = target && readDetectedAgentsForTarget(state, target)
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const chosen = state.settings?.defaultTuiAgent
  return (
    detected === null ||
    (!!detected && chosenAgentChatUnlearned(state, chosen, detected, workspace))
  )
}

/** Loads the workspace host's agent list and chat facts; resolves on success, failure, or timeout. */
export async function loadEmptyWorkspaceDefaultChatDetection(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return
  }
  await acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => ensureDetectedAgentsForTarget(state, target),
    undefined,
    true
  ).catch(() => undefined)
}

/**
 * When the user's new agent tabs open as chat, an empty workspace opens their default agent as a
 * chat instead of a bare shell. Null means nothing opened and the caller seeds the shell; so does
 * `seedShell` when the host declines the chat, since nobody asked for the agent's terminal.
 */
export function openDefaultAgentChatInEmptyWorkspace(
  worktreeId: string,
  seedShell: () => boolean
): { primaryTabId: string | null } | null {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return null
  }
  const detected = readDetectedAgentsForTarget(state, target)
  const agent = pickTuiAgent(
    state.settings?.defaultTuiAgent,
    detected ?? [],
    state.settings?.disabledTuiAgents,
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
