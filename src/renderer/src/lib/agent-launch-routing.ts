import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  clientChoosesStructuredLaunches,
  isNativeChatDefaultFor,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../../shared/structured-native-chat-launch-route'
import { parseRoutableExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'

export type AgentLaunchRoute = 'structured-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings: NativeChatDefaultSettings | null | undefined
  executionHostId: string
  /** Verified existing-workspace owner used for capability admission; never a focused fallback. */
  admissionHostId?: string
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
  if (!isNativeChatDefaultFor(input.settings, input.agent)) {
    return 'terminal-tui'
  }
  const support = structuredAgentLaunchSupport(input)
  // The existing host admission waits for its answer before opening either surface.
  const awaitingHost =
    !support.supported &&
    support.blocker === 'runtime-capability-unknown' &&
    parseRoutableExecutionHostId(input.admissionHostId ?? '')?.kind === 'runtime' &&
    clientChoosesStructuredLaunches(input.clientCapabilities)
  return support.supported || awaitingHost ? 'structured-native-chat' : 'terminal-tui'
}

// Explicit chat requests (resume history in a new chat) do not depend on the Chat UI switch.
export function structuredAgentLaunchSupported(
  input: Omit<AgentLaunchRoutingInput, 'launchText'>
): boolean {
  return structuredAgentLaunchSupport(input).supported
}

/** Whether the target host could open this agent as a chat, and why not; the settings aside. */
export function structuredAgentLaunchSupport(input: Omit<AgentLaunchRoutingInput, 'launchText'>) {
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

/** Why a launch the user wanted as a chat did not route to it; null when it did, or when the user's
 *  default for this agent is a terminal. Diagnostics only: the route itself is `resolveAgentLaunchRoute`. */
export function structuredAgentLaunchDowngrade(
  input: AgentLaunchRoutingInput,
  route: AgentLaunchRoute
): StructuredNativeChatBlocker | null {
  if (route === 'structured-native-chat' || !isNativeChatDefaultFor(input.settings, input.agent)) {
    return null
  }
  const support = structuredAgentLaunchSupport(input)
  return support.supported ? null : support.blocker
}
