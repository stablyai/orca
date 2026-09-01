import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'
import { resolveNativeChatLaunchSessionOptions } from './native-chat-session-option-enrichment'

type NativeChatLaunchSettings = Pick<
  GlobalSettings,
  | 'experimentalNativeChat'
  | 'openAgentTabsInChatByDefault'
  | 'nativeChatSessionOptions'
  | 'customTuiAgents'
  | 'deletedCustomTuiAgents'
>

export type InitialNativeChatSessionOptionsArgs = {
  agent: TuiAgent
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}

export function resolveInitialNativeChatSessionOptions(
  settings: NativeChatLaunchSettings | null | undefined,
  args: InitialNativeChatSessionOptionsArgs
): Record<string, SessionOptionValue> | undefined {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
    customTuiAgents: settings?.customTuiAgents,
    deletedCustomTuiAgents: settings?.deletedCustomTuiAgents,
    ...args
  })
  // Preferences stay keyed on the REQUESTED id: substituting the base would file
  // a custom agent's model/effort under its base and leak it across agents.
  return viewMode === 'chat'
    ? resolveNativeChatLaunchSessionOptions(settings?.nativeChatSessionOptions, args.agent)
    : undefined
}
