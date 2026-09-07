import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  prefersStructuredNativeChatByDefault,
  resolveStructuredNativeChatSupport
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'

export {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization,
  hasSemanticallyNonEmptyAgentArgs
} from '../../../shared/tui-agent-launch-customization'

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
  platform: NodeJS.Platform
  hostCapabilities: readonly string[]
  workspaceKind?: 'git-worktree' | 'folder' | 'floating'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  requiresTuiLaunchCustomization?: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  const initialViewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: input.settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: input.settings?.openAgentTabsInChatByDefault,
    agent: input.agent,
    promptDelivery: input.promptDelivery,
    launchDraftText: input.launchText,
    nativeChatTranscriptIsLocalReadable: input.nativeChatTranscriptIsLocalReadable
  })
  if (initialViewMode !== 'chat') {
    return 'terminal-tui'
  }
  if (!prefersStructuredNativeChatByDefault(input.settings)) {
    return 'legacy-native-chat'
  }
  return resolveStructuredNativeChatSupport({
    agent: input.agent,
    executionHostId: input.executionHostId,
    platform: input.platform,
    hostCapabilities: input.hostCapabilities,
    workspaceKind: input.workspaceKind,
    projectRuntime: input.projectRuntime,
    isDraftPrompt: input.promptDelivery === 'draft',
    requiresTuiLaunchCustomization: input.requiresTuiLaunchCustomization
  }).supported
    ? 'structured-native-chat'
    : 'legacy-native-chat'
}
