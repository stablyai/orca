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
