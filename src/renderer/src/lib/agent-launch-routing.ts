import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  nativeChatPreferenceFor,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'

export type AgentLaunchRoute = 'structured-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings: NativeChatDefaultSettings | null | undefined
  executionHostId: string
  /** Capabilities of the target host; `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  /** What this client advertises to a paired host. */
  clientCapabilities?: readonly string[]
  workspaceKind?: WorkspaceLaunchKind
  projectExecutionKind?: 'host' | 'ssh'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  startsOutsideWorkspaceRoot?: boolean
  /** The agents the target host listed as structured; absent until it has. */
  hostStructuredAgents?: readonly string[]
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  return nativeChatPreferenceFor(input.settings, input.agent) &&
    structuredAgentLaunchSupported(input)
    ? 'structured-native-chat'
    : 'terminal-tui'
}

// Explicit chat requests (resume history in a new chat) do not depend on the agent's Chat | CLI choice.
export function structuredAgentLaunchSupported(
  input: Omit<AgentLaunchRoutingInput, 'launchText'>
): boolean {
  return structuredAgentLaunchSupport(input).supported
}

export function structuredAgentLaunchSupport(input: Omit<AgentLaunchRoutingInput, 'launchText'>) {
  return resolveStructuredNativeChatSupport({
    agent: input.agent,
    executionHostId: input.executionHostId,
    hostCapabilities: input.hostCapabilities,
    ...(input.clientCapabilities ? { clientCapabilities: input.clientCapabilities } : {}),
    workspaceKind: input.workspaceKind,
    projectExecutionKind: input.projectExecutionKind,
    projectRuntime: input.projectRuntime,
    startsOutsideWorkspaceRoot: input.startsOutsideWorkspaceRoot,
    ...(input.hostStructuredAgents ? { hostStructuredAgents: input.hostStructuredAgents } : {})
  })
}

/** Diagnostics for chat-to-terminal fallback; route decisions remain owned by resolveAgentLaunchRoute. */
export function structuredAgentLaunchDowngrade(
  input: AgentLaunchRoutingInput,
  route: AgentLaunchRoute
): StructuredNativeChatBlocker | null {
  if (route === 'structured-native-chat' || !nativeChatPreferenceFor(input.settings, input.agent)) {
    return null
  }
  const support = structuredAgentLaunchSupport(input)
  return support.supported ? null : support.blocker
}
