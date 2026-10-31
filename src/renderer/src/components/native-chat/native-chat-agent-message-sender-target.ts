import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import {
  resolveAgentMessageSender,
  type AgentSenderResolution
} from '@/runtime/agent-sender-associations'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { sameAgentIdentity } from '../../../../shared/agent-title-owner'
import {
  agentMessageSavedKind,
  agentMessageSenderCanOpen
} from '../../../../shared/agent-session/agent-message-presentation'
import {
  readAgentMessageSenderRow,
  type SenderLocation
} from './native-chat-agent-message-sender-source'
import {
  agentMessageSenderOwner,
  unnamedSenderLabel
} from './native-chat-agent-message-sender-label'
import { locateLegacyAgentMessageSender } from './native-chat-agent-message-sender-compatibility'

/** Product switch: a terminal sender whose terminal exited or was respawned. 'host-lookup' keeps
 *  the host's own lookup on click, which may open the shell restored in its old pane; 'plain'
 *  shows the name without a link. */
export const GONE_TERMINAL_SENDER_CLICK: 'host-lookup' | 'plain' = 'host-lookup'

/** The one answer a card's avatar, link and click read, on every host. */
export type AgentMessageSenderTarget =
  | Exclude<AgentSenderResolution, { kind: 'legacy' }>
  /** The host publishes nothing (an older Orca): what this window can place for it, if anything;
   *  the click still asks that host. */
  | { kind: 'legacy'; location?: SenderLocation }
  /** Its terminal now runs a different kind of agent than the card saved. */
  | { kind: 'replaced' }
  /** No host to ask: the card isn't in a chat this window can place. */
  | { kind: 'none' }

const NONE: AgentMessageSenderTarget = Object.freeze({ kind: 'none' })
const LEGACY: AgentMessageSenderTarget = Object.freeze({ kind: 'legacy' })
const REPLACED: AgentMessageSenderTarget = Object.freeze({ kind: 'replaced' })

/** Two known kinds that can't be one agent are evidence against the sender; equal, compatible
 *  or unknown kinds prove nothing, so they don't veto. */
function knownDifferent(saved: string | undefined, row: string | undefined): boolean {
  return Boolean(saved && row && row !== 'unknown' && !sameAgentIdentity(saved, row))
}

/** The kind veto, read from the same sidebar row that draws the candidate's dot; chats are found
 *  by their own session and never vetoed as terminals. */
function replacedAt(state: AppState, sender: AgentMessageSender, location: SenderLocation) {
  return (
    !sender.party.orcaSessionId &&
    knownDifferent(
      agentMessageSavedKind(sender),
      readAgentMessageSenderRow(state, location)?.agentType
    )
  )
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
  if (resolution.kind === 'legacy') {
    const location = locateLegacyAgentMessageSender(state, sender, owner)
    return !location
      ? LEGACY
      : replacedAt(state, sender, location)
        ? REPLACED
        : { kind: 'legacy', location }
  }
  if (resolution.kind !== 'located') {
    return resolution
  }
  return replacedAt(state, sender, resolution.location) ? REPLACED : resolution
}

/** Whether the card draws a link: only where a click can open something. Federated senders stay
 *  plain names, as they always were. */
export function agentMessageSenderOpens(
  target: AgentMessageSenderTarget,
  sender: AgentMessageSender
): boolean {
  if (!agentMessageSenderCanOpen(sender)) {
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

/** A click that raced a change the link hadn't drawn yet: say what is true of this agent and
 *  what the user can do. */
export function agentMessageSenderUnavailableText(
  target: AgentMessageSenderTarget,
  name: string
): string {
  // The unnamed label reads mid-sentence; these sentences start with the sender.
  const subject =
    name === unnamedSenderLabel()
      ? translate('components.native-chat.agentMessage.unnamedSenderSubject', 'An agent')
      : name
  return target.kind === 'replaced'
    ? translate(
        'components.native-chat.agentMessage.senderReplaced',
        '{{name}} is no longer running in its terminal; another agent is running there now. Open that terminal from the sidebar if you need it.',
        { name: subject }
      )
    : target.kind === 'ambiguous'
      ? translate(
          'components.native-chat.agentMessage.senderAmbiguous',
          "Orca can't tell which terminal {{name}} is running in. Open it from the sidebar.",
          { name: subject }
        )
      : translate(
          'components.native-chat.agentMessage.senderNotRunning',
          '{{name}} is no longer running. Start a new agent from the sidebar to continue its work.',
          { name: subject }
        )
}

/** The terminal a host's lookup returned, judged by the same rule: the row this window shows
 *  for that handle on that host. */
export function agentMessageSenderReplacedOnHandle(
  state: AppState,
  sender: AgentMessageSender,
  host: string,
  handle: string
): boolean {
  const location = locateLegacyAgentMessageSender(
    state,
    { party: { address: handle, terminalHandle: handle, orcaSessionId: null }, name: null },
    host
  )
  return Boolean(
    location &&
    replacedAt(state, { ...sender, party: { ...sender.party, orcaSessionId: null } }, location)
  )
}
