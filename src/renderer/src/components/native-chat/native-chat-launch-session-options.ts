import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'
import { resolveNativeChatLaunchSessionOptions } from './native-chat-session-option-enrichment'

type NativeChatLaunchSettings = Pick<
  GlobalSettings,
  'experimentalNativeChat' | 'openAgentTabsInChatByDefault' | 'nativeChatSessionOptions'
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
    ...args
  })
  return viewMode === 'chat'
    ? resolveNativeChatLaunchSessionOptions(settings?.nativeChatSessionOptions, args.agent)
    : undefined
}
