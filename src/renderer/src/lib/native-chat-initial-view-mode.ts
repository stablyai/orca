import type { GlobalSettings, Tab, TuiAgent } from '../../../shared/types'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'

export type NativeChatLaunchPromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

/**
 * Decide the initial `viewMode` for a newly launched agent tab from the
 * opt-in `openAgentTabsInChatByDefault` setting.
 *
 * Returns `'chat'` only when the setting is explicitly on and the launched
 * agent has a native-chat renderer. Draft launches stay in the terminal because
 * their prompt exists only in the TUI input buffer.
 */
export function decideInitialAgentTabViewMode(args: {
  experimentalNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
  agent?: TuiAgent | null
  promptDelivery?: NativeChatLaunchPromptDelivery
}): Tab['viewMode'] {
  if (args.experimentalNativeChat !== true || args.openAgentTabsInChatByDefault !== true) {
    return undefined
  }
  if (!isNativeChatSupportedAgent(args.agent)) {
    return undefined
  }
  if (args.promptDelivery === 'draft') {
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
  } = {}
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
    agent: options.agent,
    promptDelivery: options.promptDelivery
  })
  return viewMode ? { viewMode } : {}
}
