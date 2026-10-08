import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  prefersStructuredNativeChatByDefault,
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatBlocker
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'

export type AgentLaunchRoute = 'structured-native-chat' | 'legacy-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings:
    | Pick<
        GlobalSettings,
        | 'experimentalNativeChat'
        | 'experimentalStructuredNativeChat'
        | 'openAgentTabsInChatByDefault'
      >
    | null
    | undefined
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
  initialSessionOptions?: Readonly<Record<string, unknown>>
  /** The agents the target host listed as structured; absent until it has. */
  hostStructuredAgents?: readonly string[]
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  // Why: structured eligibility is decided before the view-mode decider. That decider applies the
  // terminal mirror gate (a TUI cannot clear more than forty lines of prefilled draft), which has
  // no meaning for a session that seeds the composer store directly. Its other gates are already
  // implied here: the structured resolver admits only agents the host runs as chats, and
  // only hosts with an Orca runtime, and a structured session reads its journal over RPC rather
  // than the transcript file, so local transcript readability does not apply either.
  if (
    prefersStructuredNativeChatByDefault(input.settings) &&
    structuredAgentLaunchSupported(input)
  ) {
    return 'structured-native-chat'
  }
  const initialViewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: input.settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: input.settings?.openAgentTabsInChatByDefault,
    agent: input.agent,
    promptDelivery: input.promptDelivery,
    launchDraftText: input.launchText,
    nativeChatTranscriptIsLocalReadable: input.nativeChatTranscriptIsLocalReadable
  })
  return initialViewMode === 'chat' ? 'legacy-native-chat' : 'terminal-tui'
}

// Explicit chat requests do not depend on the default view mode for new tabs.
export function structuredAgentLaunchSupported(
  input: Omit<AgentLaunchRoutingInput, 'launchText'>
): boolean {
  return (
    input.settings?.experimentalStructuredNativeChat === true &&
    structuredAgentLaunchSupport(input).supported
  )
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
): StructuredNativeChatBlocker | 'new-tabs-default-to-terminal' | null {
  if (
    route === 'structured-native-chat' ||
    input.settings?.experimentalStructuredNativeChat !== true
  ) {
    return null
  }
  if (!prefersStructuredNativeChatByDefault(input.settings)) {
    return 'new-tabs-default-to-terminal'
  }
  const support = structuredAgentLaunchSupport(input)
  return support.supported ? null : support.blocker
}
