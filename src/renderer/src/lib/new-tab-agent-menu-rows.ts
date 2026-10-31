import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  readHostStructuredAgentsForRuntime,
  hostStructuredAgentsReadFailed
} from '@/runtime/host-structured-agents'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../shared/protocol-version'
import type { HostChatAnswer } from '../../../shared/agent-launch-picker-rows'
export { buildNewTabAgentMenuRows } from '../../../shared/agent-launch-picker-rows'
export type {
  HostChatAnswer,
  ChatUnavailableReason,
  NewTabAgentMenuRow,
  NewTabAgentMenuSettings
} from '../../../shared/agent-launch-picker-rows'

export function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
      return !input.hostStructuredAgents && input.hostCapabilities?.includes(CATALOG) !== false
        ? 'not-yet-known'
        : 'not-on-host'
    case 'remote-execution-host':
      return 'ssh'
    case 'project-runtime':
      return 'wsl'
    case 'runtime-capability':
    case 'client-capability':
      return 'no-chats'
    case 'custom-start-directory':
      return 'subfolder'
    case 'reused-terminal':
      return 'yes'
  }
}

export function hostChatCatalogUnlearned(
  host: string,
  runtimeId: string | null | undefined,
  capabilities: readonly string[] | null | undefined
): boolean {
  return (
    runtimeId !== undefined &&
    capabilities?.includes(CATALOG) === true &&
    !readHostStructuredAgentsForRuntime(host, runtimeId) &&
    !hostStructuredAgentsReadFailed(host, runtimeId)
  )
}

export function agentMenuChatAgents(
  settings: Pick<GlobalSettings, 'nativeChatProviders' | 'agentDefaultSurface'> | null | undefined,
  localCatalog: readonly string[] | undefined,
  hostCatalog: readonly string[] | undefined
): TuiAgent[] {
  const chatAgents = [
    ...new Set([
      'claude',
      'codex',
      ...(localCatalog ?? []),
      ...(hostCatalog ?? []),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => nativeChatPreferenceFor(settings, agent))
    ])
  ].filter(isTuiAgent)
  return chatAgents
}
