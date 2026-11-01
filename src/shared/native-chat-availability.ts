import type { Tab } from './tab-types'
import type { TuiAgent } from './tui-agent'
import type { AgentType } from './agent-status-types'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from './native-chat/native-chat-agent-support'

/** Resolve launched/detected identity from the tab and status before applying this pure toggle policy. */
export type NativeChatAvailabilityInput = {
  contentType: Tab['contentType']
  /** Only WSL projects retain the terminal-backed chat view. */
  isWslProject?: boolean | null
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

export type NativeChatSavedDisposition = 'recover' | 'pending' | 'retire'

/** Entry permission cannot revoke an already saved presentation choice. */
export function nativeChatPresentationPolicy(input: NativeChatAvailabilityInput): {
  canEnter: boolean
  saved: NativeChatSavedDisposition
} {
  const agent = nativeChatAvailabilityAgent(input)
  const available = isNativeChatAgentAvailable(
    agent,
    input.nativeChatTranscriptIsLocalReadable === true
  )
  const retired =
    input.contentType !== 'terminal' ||
    input.isWslProject === false ||
    (agent !== null && !isNativeChatSupportedAgent(agent))
  return {
    canEnter: !retired && input.isWslProject === true && available,
    saved: retired ? 'retire' : available ? 'recover' : 'pending'
  }
}

/** Return to terminal everywhere; entry requires a WSL project and a supported, readable agent. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  return (
    input.contentType === 'terminal' &&
    (input.isChatViewMode === true || nativeChatPresentationPolicy(input).canEnter)
  )
}
