// Whether a bot may use Google and where this host's Google sign-in stands, as separate facts; each
// caller (offer, a bot's setup start, `bot connectors`, Add connector) picks its own step from them.
import type { GoogleAccountView } from './google-connect-types'

export type GoogleHostConnect = 'no-app' | 'signed-out' | 'reconnect' | 'connected'

export type GoogleBotConnectState = {
  /** The owner turned Google on for this bot. */
  allowed: boolean
  host: GoogleHostConnect
}

export function googleBotConnectState(input: {
  allowed: boolean
  client: unknown
  accounts: readonly Pick<GoogleAccountView, 'status'>[]
}): GoogleBotConnectState {
  const { allowed, client, accounts } = input
  const host: GoogleHostConnect = accounts.some((account) => account.status === 'connected')
    ? 'connected'
    : accounts.length > 0
      ? 'reconnect'
      : client
        ? 'signed-out'
        : 'no-app'
  return { allowed, host }
}

/** What a bot's ask for Google comes to: nothing to do, a Connect card, or (where no owner window can
 *  answer a card) a line saying what to do. A bot's setup start with no app here runs the setup instead. */
export type GoogleBotAsk = {
  kind: 'on' | 'card' | 'server'
  message: string
}

export function googleBotAsk(
  state: GoogleBotConnectState,
  context: { from: 'offer' | 'start'; headless: boolean; botName: string }
): GoogleBotAsk {
  const { from, headless, botName } = context
  if (state.allowed && state.host === 'connected') {
    // An offer while on is the owner wanting another account: the Connected card adds one.
    return from === 'offer' && !headless
      ? {
          kind: 'card',
          message:
            "Google is already on for you. Your owner now sees Google's Connected card in this chat, where they can add another Google account. `orca bot connectors` shows each account and which is the default; pass --account to use another."
        }
      : {
          kind: 'on',
          message: headless
            ? 'Google is on for you and signed in; no card was shown. Your owner adds another Google account with `orca google connect` in a terminal on this server. `orca bot connectors` shows each account and which is the default.'
            : 'Google is on for you and signed in; no card was shown. `orca bot connectors` shows each service.'
        }
  }
  if (headless) {
    return { kind: 'server', message: serverLine(state, botName) }
  }
  return {
    kind: 'card',
    message:
      from === 'start'
        ? "Google's app is already on this computer, so there is no app to make: your owner now sees a Connect card for Google in this chat instead. End your turn; their answer reaches you."
        : "Your owner now sees a Connect card for Google in this chat; it turns to Connected once they connect it. Don't tell them where to click."
  }
}

function serverLine(state: GoogleBotConnectState, botName: string): string {
  switch (state.host) {
    case 'connected':
      return `No card was shown. Your owner turns Google on for you with \`orca google bot ${botName} --on\` in a terminal on this server.`
    case 'signed-out':
    case 'reconnect':
      return "No card was shown. A Google app is configured on this server, but its account needs signing in (or reconnecting) here; turning Google on for you alone won't fix it."
    case 'no-app':
      return 'No card was shown. Google has no app configured on this server; start setup here with `orca bot google-setup start`.'
  }
}
