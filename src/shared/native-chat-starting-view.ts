import { AGENT_TUI_CLEAR_MAX_LINES, countAgentTuiInputLines } from './agent-tui-input-clear'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from './native-chat-agent-support'
import { agentTabsDefaultToNativeChat } from './structured-native-chat-launch-route'
import type { TerminalTabViewMode } from './terminal-tab-view-mode'

export type NativeChatLaunchPromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

/**
 * Single source of truth for whether unsent launch context can be mirrored from
 * the agent's TUI input into the native-chat composer.
 *
 * Both the seeding path (`seedNativeChatLaunchDraftForAgentTab`) and the
 * starting-view decision gate on this one predicate, so a draft launch can never
 * open in chat with a composer that chat then refuses to fill.
 *
 * CR/LF drafts are safe within the bounded TUI-clear budget. Unicode line
 * separators and drafts beyond that budget remain terminal-only.
 */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !/[\u2028\u2029]/.test(text) &&
    countAgentTuiInputLines(text) <= AGENT_TUI_CLEAR_MAX_LINES
  )
}

export type AgentTabStartingViewInput = {
  /** A decided view: the launcher's genuine choice, a recorded one (Agent Sleep), or a pin. */
  viewMode?: TerminalTabViewMode
  /** The launching device's Chat UI default; absent means the deciding host's own applies. */
  launcherDefaultView?: TerminalTabViewMode
  /** The deciding host's (or the local device's) Chat UI settings. */
  settings:
    | { experimentalNativeChat?: boolean; openAgentTabsInChatByDefault?: boolean }
    | null
    | undefined
  /** The launched agent; none means a plain shell, which gets no starting view. */
  agent?: string | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** The unsent launch context, when `promptDelivery` is `'draft'`. */
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}

function draftCanShowInChat(input: AgentTabStartingViewInput): boolean {
  return (
    input.promptDelivery !== 'draft' ||
    canMirrorLaunchDraftToNativeChat(input.launchDraftText ?? '')
  )
}

/** Whether chat can show this launch at all. */
function chatCanShowLaunch(input: AgentTabStartingViewInput): boolean {
  if (!isNativeChatSupportedAgent(input.agent)) {
    return false
  }
  if (
    nativeChatRequiresLocalTranscript(input.agent) &&
    input.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return false
  }
  return draftCanShowInChat(input)
}

/**
 * The view a new agent tab records at creation, decided once. A decided `viewMode` is kept (chat
 * only where chat can show it). Otherwise the launching device's default, else the host's, applies
 * like any default: chat when chat can show the launch, and nothing when it is terminal, so every
 * viewer keeps its own default for a tab nobody switched. The one exception pins terminal: a draft
 * chat cannot mirror, because a viewer whose default is chat would hide that draft.
 * Idempotent: re-finalizing a result with the same inputs returns it unchanged.
 */
export function finalizeAgentTabStartingView(
  input: AgentTabStartingViewInput
): TerminalTabViewMode | undefined {
  if (!input.agent) {
    return undefined
  }
  if (input.viewMode) {
    return input.viewMode === 'chat' && chatCanShowLaunch(input) ? 'chat' : 'terminal'
  }
  if (!isNativeChatSupportedAgent(input.agent)) {
    return undefined
  }
  // An empty draft hides nothing, so it pins nothing.
  if (!draftCanShowInChat(input) && input.launchDraftText?.trim()) {
    return 'terminal'
  }
  const defaultIsChat = input.launcherDefaultView
    ? input.launcherDefaultView === 'chat'
    : agentTabsDefaultToNativeChat(input.settings)
  return defaultIsChat && chatCanShowLaunch(input) ? 'chat' : undefined
}
