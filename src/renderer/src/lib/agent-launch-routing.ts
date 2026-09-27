import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  agentTabsDefaultToNativeChat,
  isNativeChatEnabled,
  resolveStructuredNativeChatSupport
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'

export { hasExplicitTuiLaunchCommand } from '../../../shared/tui-agent-launch-command-override'

export type AgentLaunchRoute = 'structured-native-chat' | 'legacy-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings:
    | Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'>
    | null
    | undefined
  executionHostId: string
  /** Capabilities of the target host; `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  workspaceKind?: WorkspaceLaunchKind
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  requiresTuiLaunchCommand?: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  // Why: structured eligibility is decided before the view-mode decider. That decider applies the
  // terminal mirror gate (a TUI cannot clear more than forty lines of prefilled draft), which has
  // no meaning for a session that seeds the composer store directly. Its other gates are already
  // implied here: the structured resolver admits only claude/codex, both native-chat agents, and
  // refuses every non-local host, and a structured session reads its journal over RPC rather than
  // the transcript file, so local transcript readability does not apply either.
  if (agentTabsDefaultToNativeChat(input.settings) && structuredAgentLaunchSupported(input)) {
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
    isNativeChatEnabled(input.settings) &&
    resolveStructuredNativeChatSupport({
      agent: input.agent,
      executionHostId: input.executionHostId,
      hostCapabilities: input.hostCapabilities,
      workspaceKind: input.workspaceKind,
      projectRuntime: input.projectRuntime,
      requiresTuiLaunchCommand: input.requiresTuiLaunchCommand
    }).supported
  )
}
