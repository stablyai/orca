import type { GlobalSettings, Tab, TuiAgent } from '../../../shared/types'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '@/lib/native-chat-supported-agent'

export type NativeChatLaunchPromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

/**
 * Decide the initial `viewMode` for a newly launched agent tab from the
 * opt-in `openAgentTabsInChatByDefault` setting.
 *
 * Returns `'chat'` only when the setting is explicitly on and the launched
 * agent has a native-chat renderer. A draft launch opens in chat only when its
 * unsent context can be mirrored into the composer — gated on the same
 * predicate as seeding so the view never opens empty beside a filled TUI input.
 */
export function decideInitialAgentTabViewMode(args: {
  experimentalNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
  agent?: TuiAgent | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** The unsent launch context, when `promptDelivery` is `'draft'`. */
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}): Tab['viewMode'] {
  if (args.experimentalNativeChat !== true || args.openAgentTabsInChatByDefault !== true) {
    return undefined
  }
  if (!isNativeChatSupportedAgent(args.agent)) {
    return undefined
  }
  if (
    nativeChatRequiresLocalTranscript(args.agent) &&
    args.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return undefined
  }
  if (
    args.promptDelivery === 'draft' &&
    !canMirrorLaunchDraftToNativeChat(args.launchDraftText ?? '')
  ) {
    return undefined
  }
  return 'chat'
}

export function initialAgentTabViewModeProps(
  settings:
    | Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'>
    | null
    | undefined,
  options: {
    agent?: TuiAgent | null
    promptDelivery?: NativeChatLaunchPromptDelivery
    launchDraftText?: string
    nativeChatTranscriptIsLocalReadable?: boolean
  } = {}
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
    agent: options.agent,
    promptDelivery: options.promptDelivery,
    launchDraftText: options.launchDraftText,
    nativeChatTranscriptIsLocalReadable: options.nativeChatTranscriptIsLocalReadable
  })
  return viewMode ? { viewMode } : {}
}
