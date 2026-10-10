import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  isNativeChatEnabled,
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatBlocker
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'

export type AgentLaunchRoute = 'structured-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings: Pick<GlobalSettings, 'experimentalNativeChat'> | null | undefined
  executionHostId: string
  /** Capabilities of the target host; `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  /** What this client advertises to a paired host. */
  clientCapabilities?: readonly string[]
  workspaceKind?: WorkspaceLaunchKind
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  startsOutsideWorkspaceRoot?: boolean
  /** The agents the target host listed as structured; absent until it has. */
  hostStructuredAgents?: readonly string[]
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  return isNativeChatEnabled(input.settings) && structuredAgentLaunchSupported(input)
    ? 'structured-native-chat'
    : 'terminal-tui'
}

// Explicit chat requests (resume history in a new chat) do not depend on the Chat UI switch.
export function structuredAgentLaunchSupported(
  input: Omit<AgentLaunchRoutingInput, 'launchText'>
): boolean {
  return structuredAgentLaunchSupport(input).supported
}

function structuredAgentLaunchSupport(input: Omit<AgentLaunchRoutingInput, 'launchText'>) {
  return resolveStructuredNativeChatSupport({
    agent: input.agent,
    executionHostId: input.executionHostId,
    hostCapabilities: input.hostCapabilities,
    ...(input.clientCapabilities ? { clientCapabilities: input.clientCapabilities } : {}),
    workspaceKind: input.workspaceKind,
    projectRuntime: input.projectRuntime,
    startsOutsideWorkspaceRoot: input.startsOutsideWorkspaceRoot,
    ...(input.hostStructuredAgents ? { hostStructuredAgents: input.hostStructuredAgents } : {})
  })
}

/** Why a launch with structured chat turned on did not route to it; null when it did, or when
 *  structured chat is off. Diagnostics only: the route itself is `resolveAgentLaunchRoute`. */
export function structuredAgentLaunchDowngrade(
  input: AgentLaunchRoutingInput,
  route: AgentLaunchRoute
): StructuredNativeChatBlocker | null {
  if (route === 'structured-native-chat' || !isNativeChatEnabled(input.settings)) {
    return null
  }
  const support = structuredAgentLaunchSupport(input)
  return support.supported ? null : support.blocker
}
