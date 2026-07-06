import type { Tab, TuiAgent } from '../../../../shared/types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'

export { isNativeChatSupportedAgent }

/** Inputs that decide whether a tab may toggle into the native chat view.
 *  Kept as a plain shape (not the live store) so the decision stays pure and
 *  unit-testable; call sites resolve `launchAgent`/`detectedAgent` from the
 *  terminal tab + agent-status before calling. */
export type NativeChatAvailabilityInput = {
  /** Feature flag: hidden unless enabled from Settings > Experimental. */
  experimentalNativeChatEnabled?: boolean
  contentType: Tab['contentType']
  /** The coding-agent Orca launched in this terminal, if any (from TerminalTab). */
  launchAgent?: TuiAgent | null
  /** The agent identity from a live agent-status entry for any pane of this tab,
   *  when one exists — i.e. an agent detected at runtime even though
   *  `launchAgent` was not set (manually-started agents, resumed sessions). */
  detectedAgent?: AgentType | null
  /** The agent identity from another trusted tab signal (for example the
   *  terminal title resolver) when it identifies the foreground as an agent
   *  before hooks arrive. */
  resolvedAgent?: TuiAgent | null
  /** Already-chat tabs must always be allowed to toggle back to terminal, even
   *  if live hook state was lost during a dev/app restart. */
  isChatViewMode?: boolean
}

/** Native chat is a rendering of a coding-agent conversation, so the toggle is
 *  only meaningful on terminals that actually run an agent we can parse. Plain
 *  shells, non-terminal surfaces (editor, browser, …), and unsupported agents
 *  (Grok, Gemini, …) never qualify. Live identity is authoritative when present;
 *  launch metadata is next, and title resolution only fills the pre-hook gap for
 *  manually-started Claude/Codex sessions. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  if (input.experimentalNativeChatEnabled !== true) {
    return false
  }
  if (input.contentType !== 'terminal') {
    return false
  }
  if (input.isChatViewMode === true) {
    return true
  }
  const agent = input.detectedAgent ?? input.launchAgent ?? input.resolvedAgent
  return isNativeChatSupportedAgent(agent)
}
