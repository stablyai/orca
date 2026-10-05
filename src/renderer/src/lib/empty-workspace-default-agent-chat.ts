import { agentTabsDefaultToNativeChat } from '../../../shared/structured-native-chat-launch-route'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'

// Why bounded: detection only decides chat vs shell, so a slow host must not hold the workspace empty.
const DEFAULT_CHAT_DETECTION_TIMEOUT_MS = 5_000

/**
 * The host whose agent list picks the default chat; undefined when the workspace opens a shell
 * whatever that list says. Shared by the wait and the open so they cannot drift.
 */
function defaultChatDetectionTarget(
  state: AppState,
  worktreeId: string
): AgentDetectionTarget | undefined {
  // Why: a 'blank' default means the user wants workspaces to open without an agent.
  if (
    !agentTabsDefaultToNativeChat(state.settings) ||
    state.settings?.defaultTuiAgent === 'blank'
  ) {
    return undefined
  }
  // Why: an unresolved owner is an unknown host, not the local machine.
  return parseAgentDetectionTargetKey(getAgentDetectionTargetKeyForWorktree(state, worktreeId))
}

/** Same host lists the tab bar reads; null means that host's detection has not loaded. */
function readDetectedAgents(state: AppState, target: AgentDetectionTarget): TuiAgent[] | null {
  if (target.kind === 'ssh') {
    return state.remoteDetectedAgentIds[target.connectionId] ?? null
  }
  if (target.kind === 'runtime') {
    return state.runtimeDetectedAgentIds[target.environmentId] ?? null
  }
  return target.contextKey
    ? (state.localDetectedAgentIdsByContext[target.contextKey] ?? null)
    : state.detectedAgentIds
}

/** True when the default chat could open here but the workspace host's agent list has not loaded. */
export function emptyWorkspaceDefaultChatAwaitsDetection(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  return target !== undefined && readDetectedAgents(state, target) === null
}

/** Loads the workspace host's agent list; resolves on success, failure, or timeout. */
export async function loadEmptyWorkspaceDefaultChatDetection(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return
  }
  const detection =
    target.kind === 'ssh'
      ? state.ensureRemoteDetectedAgents(target.connectionId)
      : target.kind === 'runtime'
        ? state.ensureRuntimeDetectedAgents(target.environmentId)
        : state.ensureDetectedAgents(target.worktreeId)
  await withTimeout(detection, DEFAULT_CHAT_DETECTION_TIMEOUT_MS, [])
}

/**
 * When the user's new agent tabs open as chat, an empty workspace opens their default agent as a
 * chat instead of a bare shell. Null means nothing opened and the caller seeds the shell.
 */
export function openDefaultAgentChatInEmptyWorkspace(
  worktreeId: string
): { primaryTabId: string | null } | null {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return null
  }
  const agent = pickTuiAgent(
    state.settings?.defaultTuiAgent,
    readDetectedAgents(state, target) ?? [],
    state.settings?.disabledTuiAgents
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
    pendingActivationSpawn: true
  })
  if (!result) {
    return null
  }
  return { primaryTabId: result.surface.kind === 'host-published' ? null : result.surface.tabId }
}
