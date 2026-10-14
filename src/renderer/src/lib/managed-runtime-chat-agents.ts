import type { TuiAgent } from '../../../shared/tui-agent'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import { workspaceKindForWorktreeId } from '../../../shared/workspace-launch-kind'
import { readHostStructuredAgents } from '@/runtime/host-structured-agents'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import { resolveAgentLaunchRoute } from '@/lib/agent-launch-routing'

/** The detected agents plus those a launch here opens as a chat whose program the host provides,
 *  which need no CLI; a terminal launch still needs its CLI detected. */
export function withManagedRuntimeChatAgents(
  store: AgentLaunchRouteStore,
  worktreeId: string,
  detected: readonly TuiAgent[]
): TuiAgent[] {
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const added = ALL_TUI_AGENTS.filter((agent) => {
    if (detected.includes(agent)) {
      return false
    }
    const input = buildAgentLaunchRouteInput(store, { agent, workspace })
    const row = readHostStructuredAgents(
      input.executionHostId,
      store.runtimeStatusByEnvironmentId
    )?.find((listed) => listed.agent === agent)
    return (
      row?.managedRuntime === true && resolveAgentLaunchRoute(input) === 'structured-native-chat'
    )
  })
  return [...detected, ...added]
}
