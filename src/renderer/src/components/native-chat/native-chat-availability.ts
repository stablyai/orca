import type { Tab } from '../../../../shared/tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '@/lib/native-chat-supported-agent'

export { isNativeChatSupportedAgent }

/** Resolve launched/detected identity from the tab and status before applying this pure toggle policy. */
export type NativeChatAvailabilityInput = {
  contentType: Tab['contentType']
  /** The coding-agent Orca launched in this terminal, if any (from TerminalTab). */
  launchAgent?: TuiAgent | null
  /** Live identity for manually launched or resumed agents without launch metadata. */
  detectedAgent?: AgentType | null
  /** Trusted pre-hook identity, such as the terminal title resolver. */
  resolvedAgent?: TuiAgent | null
  /** Whether this renderer's native-chat reader can access the agent transcript. */
  nativeChatTranscriptIsLocalReadable?: boolean
  /** Allow return to terminal even if a restart lost agent evidence. */
  isChatViewMode?: boolean
}

/** Existing chat views may return to terminal; entry requires supported, readable agent identity in detected/launch/resolved order. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  if (input.contentType !== 'terminal') {
    return false
  }
  if (input.isChatViewMode === true) {
    return true
  }
  const agent = input.detectedAgent ?? input.launchAgent ?? input.resolvedAgent
  if (
    nativeChatRequiresLocalTranscript(agent) &&
    input.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return false
  }
  return isNativeChatSupportedAgent(agent)
}
