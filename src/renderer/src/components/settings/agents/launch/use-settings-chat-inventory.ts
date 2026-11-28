import { shallow } from 'zustand/shallow'
import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { chatProviderAgents } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { readHostStructuredAgentsForRuntime } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  readChatProgram,
  resolveChatProgramContext
} from '@/lib/agent-session/launch/inventory/host-chat-program'
import {
  agentLaunchRouteStoreFor,
  type ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { chatProgramInstalled } from '../../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'

export function useSettingsChatInventory(
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null,
  chatSupported: boolean
) {
  return useAppStateValueWithHostStatuses((appState, statuses) => {
    if (!chatSupported) {
      return { chatOnlyKey: '', chatInventoryReady: true }
    }
    const state = agentLaunchRouteStoreFor(appState, statuses)
    const context = resolveChatProgramContext(state, workspace)
    // The host can register additional agents whose chat program needs checking.
    let chatInventoryReady =
      context.hostCapabilities !== null &&
      context.runtimeId !== undefined &&
      (!context.hostCapabilities.includes(CATALOG) ||
        readHostStructuredAgentsForRuntime(context.executionHostId, context.runtimeId) !==
          undefined)
    const chatOnly: TuiAgent[] = []
    for (const agent of chatProviderAgents(context.executionHostId, statuses)) {
      if (detected?.includes(agent)) {
        continue
      }
      const program = readChatProgram(statuses, agent, context, detected)
      if (chatProgramInstalled(program)) {
        chatOnly.push(agent)
      } else if (program === 'unlearned' || program === 'unknown') {
        chatInventoryReady = false
      }
    }
    return { chatOnlyKey: chatOnly.join(' '), chatInventoryReady }
  }, shallow)
}
