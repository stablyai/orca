// Which screen Cliq setup shows, from the account's Cliq sign-ins, the connect trip and the owner's choices.
import type { BotCliqView } from '@/lib/bot-cliq-state'
import type { ConnectorConnectView } from '@/lib/connector-connect-state'
import type { ConnectorCliqState } from '../../../../../shared/connector-bot-cliq-contract'
import { BOT_CLIQ_OFF } from '../../../../../shared/connector-bot-cliq-contract'

export type CliqSignIn = ConnectorCliqState['orgs'][number]

export type BotCliqSetupStep =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  /** No usable sign-in: one trip signs in to Zoho and picks the organization. */
  | { kind: 'connect'; error: string | null }
  /** Signed in to several organizations the bot is not in: the owner picks one, or adds another. */
  | { kind: 'pick'; orgs: CliqSignIn[] }
  | { kind: 'waiting' }
  /** Zoho no longer takes the sign-in there: signing in again fixes it. */
  | { kind: 'expired'; org: CliqSignIn }
  | { kind: 'turn-on'; org: CliqSignIn }
  | { kind: 'done' }

export function botCliqSetupStep(
  view: BotCliqView,
  connect: ConnectorConnectView,
  /** `taken`: organizations the bot is already in, never picked for it as the only one signed in. */
  choice: { orgId: string | null; done: boolean; taken?: readonly string[] }
): BotCliqSetupStep {
  if (choice.done) {
    return { kind: 'done' }
  }
  if (connect.status === 'waiting') {
    return { kind: 'waiting' }
  }
  if (view.status === 'loading') {
    return { kind: 'checking' }
  }
  if (view.status !== 'ready') {
    return { kind: 'failed', code: view.status === 'off' ? BOT_CLIQ_OFF : view.error }
  }
  const { orgs } = view.cliq
  // The trip's organization first, then the one asked for or picked, then the only one signed in.
  const wanted = (connect.status === 'linked' ? connect.link.org?.orgId : undefined) ?? choice.orgId
  const open = orgs.filter((entry) => !choice.taken?.includes(entry.orgId))
  // An organization asked for by name (repairing its row) is never swapped for another one.
  const org =
    orgs.find((entry) => entry.orgId === wanted) ??
    (wanted == null && open.length === 1 ? open[0] : null)
  if (!org) {
    // The asked-for organization has no sign-in here: signing in there is the way on.
    if (wanted != null) {
      return { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
    }
    return open.length > 1
      ? { kind: 'pick', orgs: open }
      : { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
  }
  return org.expired ? { kind: 'expired', org } : { kind: 'turn-on', org }
}
