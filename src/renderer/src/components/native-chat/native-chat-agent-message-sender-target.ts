import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import {
  resolveAgentMessageSender,
  type AgentSenderResolution
} from '@/runtime/agent-sender-associations'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readAgentMessageSenderRow } from './native-chat-agent-message-sender-source'
import { agentMessageSenderOwner } from './native-chat-agent-message-sender-label'

/** Product switch: a terminal sender whose terminal exited or was respawned. 'host-lookup' keeps
 *  the host's own lookup on click, which may open the shell restored in its old pane; 'plain'
 *  shows the name without a link. */
export const GONE_TERMINAL_SENDER_CLICK: 'host-lookup' | 'plain' = 'host-lookup'

/** The one answer a card's avatar, link and click read. */
export type AgentMessageSenderTarget =
  | AgentSenderResolution
  /** Its terminal now runs a different kind of agent than the card saved. */
  | { kind: 'replaced' }
  /** No host to ask: the card isn't in a chat this window can place. */
  | { kind: 'none' }

const NONE: AgentMessageSenderTarget = Object.freeze({ kind: 'none' })
const REPLACED: AgentMessageSenderTarget = Object.freeze({ kind: 'replaced' })

/** A row whose agent is known and differs from the saved one is evidence against the sender;
 *  matching or unknown kinds prove nothing, so they don't veto. */
function differentAgent(saved: string | undefined, row: string | undefined): boolean {
  return Boolean(saved && row && row !== 'unknown' && row !== saved)
}

export function resolveAgentMessageSenderTarget(
  state: AppState,
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined,
  dispatchId: string | undefined
): AgentMessageSenderTarget {
  const owner = agentMessageSenderOwner(state, chatWorktreeId, target)
  if (!owner) {
    return NONE
  }
  const resolution = resolveAgentMessageSender(state, owner, sender, dispatchId)
  if (resolution.kind !== 'located' || resolution.location.sessionId) {
    return resolution
  }
  const row = readAgentMessageSenderRow(state, resolution.location)
  return differentAgent(sender.agent, row?.agentType) ? REPLACED : resolution
}

/** Whether the card draws a link: only where a click can open something. Federated senders stay
 *  plain names, as they always were. */
export function agentMessageSenderOpens(
  target: AgentMessageSenderTarget,
  sender: AgentMessageSender
): boolean {
  if (sender.party.address.startsWith('dispatch:')) {
    return false
  }
  switch (target.kind) {
    // 'none': the chat's host isn't known yet; the click asks for it, as it always has.
    case 'located':
    case 'legacy':
    case 'none':
      return true
    case 'gone':
      return (
        target.sender === 'chat' ||
        (target.sender === 'terminal' && GONE_TERMINAL_SENDER_CLICK === 'host-lookup')
      )
    default:
      return false
  }
}

/** A click that raced a change the link hadn't drawn yet: say what is true of this agent. */
export function agentMessageSenderUnavailableText(
  target: AgentMessageSenderTarget,
  name: string
): string {
  return target.kind === 'replaced'
    ? translate(
        'components.native-chat.agentMessage.senderReplaced',
        '{{name}} is no longer running in its terminal; another agent is running there now. Open that terminal from the sidebar if you need it.',
        { name }
      )
    : target.kind === 'ambiguous'
      ? translate(
          'components.native-chat.agentMessage.senderAmbiguous',
          "Orca can't tell which terminal {{name}} is running in. Open it from the sidebar.",
          { name }
        )
      : translate(
          'components.native-chat.agentMessage.senderNotRunning',
          '{{name}} is no longer running. Its messages stay in this chat.',
          { name }
        )
}

/** True when a known different agent now runs in the terminal a host lookup returned. */
export function agentMessageSenderReplacedOnHandle(
  state: AppState,
  sender: AgentMessageSender,
  handle: string
): boolean {
  const kinds = new Set(
    Object.values(state.agentStatusByPaneKey).flatMap((entry) =>
      entry.terminalHandle === handle ? [entry.agentType] : []
    )
  )
  return kinds.size === 1 && differentAgent(sender.agent, [...kinds][0])
}
