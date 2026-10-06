import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  finalizeAgentTabStartingView,
  type NativeChatLaunchPromptDelivery
} from '../../../shared/native-chat-starting-view'

export type { NativeChatLaunchPromptDelivery }

/**
 * Whether this device's `openAgentTabsInChatByDefault` default opens a newly launched agent tab
 * in chat: `'chat'`, or `undefined` for every other answer (the shared starting-view policy).
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
  return finalizeAgentTabStartingView({ ...args, settings: args }) === 'chat' ? 'chat' : undefined
}

/**
 * The starting view this device stamps on an agent tab it mints: chat, a terminal pin for a draft
 * chat cannot mirror, or nothing (a tab nobody switched).
 */
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
  const viewMode = finalizeAgentTabStartingView({ ...options, settings })
  return viewMode ? { viewMode } : {}
}
