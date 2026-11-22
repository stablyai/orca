import { agentMessageSenderName } from '../../agent-session/journal/agent-session-message-source'

/** Who sent mail from a computer paired with this one, either side of the pairing. `computer` is
 *  this computer's name for a server it pulls from, or a client's Orca's name for itself; '' when
 *  none was named. `botName` is the sender's bot as its own Orca named it. */
export type PairedSender = { computer: string; botName: string | null }

/** That computer's bot by name on it, or an agent there. Never "your owner's": a paired computer
 *  may be someone else's. */
export function pairedSenderName(sender: PairedSender): string {
  const computer = sender.computer || 'another computer'
  return sender.botName ? `${sender.botName} on ${computer}` : `an agent on ${computer}`
}

/** The computer a paired Orca's mail label names. Every Orca labels its mail `<address> on <computer>`,
 *  and an address has no spaces, so an Orca from before it sent a sender still says where it is from. */
export function pairedLabelComputer(label: string): string | null {
  const at = label.indexOf(' on ')
  if (at <= 0 || label.slice(0, at).includes(' ')) {
    return null
  }
  return agentMessageSenderName(label.slice(at + ' on '.length))
}
