// Each step of one run of "Add <bot> to Slack", as the setup hook tracks it and the dialog draws it.
import type { SlackInstallLink } from './slack-install-link'

export type BotSlackSetupStep =
  | { kind: 'checking' }
  /** Another workspace for a bot already in Slack: one this computer's bots are in, or a new one. */
  | { kind: 'pick'; teamIds: string[] }
  /**
   * `teamId`: the workspace whose token lapsed. `mine`: that token is this desktop's own Orca
   * account's, from a hand-off; the new one is saved there and the hand-off runs again.
   * `unsure`: Slack refused, yet this account may never have saved a token there.
   */
  | {
      kind: 'token'
      reconnect: boolean
      error: string | null
      teamId?: string
      mine?: boolean
      unsure?: true
    }
  /** `handOff`: this desktop's own Orca account creates the app. */
  | { kind: 'setting-up'; handOff?: boolean }
  /** A paired computer's bot: its app is made; Slack's page opens only on Approve in Slack. */
  | { kind: 'ready'; teamId: string; link: SlackInstallLink }
  /** `returnUrl`: where Slack's page sends the browser back, read at once on landing. */
  | {
      kind: 'waiting'
      teamId: string
      returnUrl: string | null
      link: SlackInstallLink | null
      copied: boolean
    }
  | { kind: 'expired'; teamId: string }
  /** Slack says a Slack user other than the token's approved the link. */
  | { kind: 'other-user'; teamId: string }
  | { kind: 'uncertain'; teamId: string }
  /** `teamId`: the workspace it is in, whose people the owner then picks. */
  /** `setupState`: the install link this flow installed with, so its identity pick applies at once. */
  | { kind: 'installed'; teamId: string; setupState?: string }
  /** `code` is the desktop error code, so a signed-out failure can offer Sign in; `local`: this
   *  computer's own account failed. `teamId`, `handOff`: the workspace and step a recovery resumes. */
  | { kind: 'failed'; code: string; local?: true; teamId?: string; handOff?: boolean }
