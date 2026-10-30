import type { Tab } from './tab-types'
import type { TuiAgent } from './tui-agent'
import type { AgentType } from './agent-status-types'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from './native-chat-agent-support'

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

/** The first identity claim in detected/launch/resolved order; an unsupported claim is not skipped. */
export function nativeChatAvailabilityAgent(input: {
  detectedAgent?: string | null
  launchAgent?: string | null
  resolvedAgent?: string | null
}): string | null {
  return input.detectedAgent ?? input.launchAgent ?? input.resolvedAgent ?? null
}

/** Whether chat can open on this agent where the reader can (or cannot) read its transcript. */
export function isNativeChatAgentAvailable(
  agent: string | null | undefined,
  transcriptIsLocalReadable: boolean
): boolean {
  if (nativeChatRequiresLocalTranscript(agent) && !transcriptIsLocalReadable) {
    return false
  }
  return isNativeChatSupportedAgent(agent)
}

/** Existing chat views may return to terminal; entry requires supported, readable agent identity in detected/launch/resolved order. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  if (input.contentType !== 'terminal') {
    return false
  }
  if (input.isChatViewMode === true) {
    return true
  }
  return isNativeChatAgentAvailable(
    nativeChatAvailabilityAgent(input),
    input.nativeChatTranscriptIsLocalReadable === true
  )
}
