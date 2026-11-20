// Which screen Cliq setup shows, from the account's Cliq sign-ins, the connect trip and the owner's choices.
import type { BotCliqView } from '@/lib/bot-cliq-state'
import type { ConnectorConnectView } from '@/lib/connector-connect-state'
import type { ConnectorCliqState } from '../../../../../shared/connector-bot-cliq-contract'
import { BOT_CLIQ_OFF } from '../../../../../shared/connector-bot-cliq-contract'

/** A repair's sign-in reached another organization than the row's. */
export const CLIQ_OTHER_ORG = 'cliq_other_org'

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
  /** `target`: the row's organization being repaired, never swapped for another. `picked`: the
   *  owner's choice in an add. `taken`: organizations the bot is already in, never picked for it as
   *  the only one signed in. */
  choice: { target: string | null; picked: string | null; done: boolean; taken?: readonly string[] }
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
  const linkedOrg = connect.status === 'linked' ? connect.link.org?.orgId : undefined
  if (choice.target !== null) {
    // A repair keeps its row's organization: a sign-in that reached another one never replaces it.
    // A sign-in this trip that reached another organization failed the repair, even when the
    // row's own (expired) sign-in is still listed.
    const org =
      linkedOrg === undefined || linkedOrg === choice.target
        ? orgs.find((entry) => entry.orgId === choice.target)
        : undefined
    if (org) {
      return org.expired ? { kind: 'expired', org } : { kind: 'turn-on', org }
    }
    return {
      kind: 'connect',
      error:
        connect.status === 'failed'
          ? connect.error
          : linkedOrg !== undefined
            ? CLIQ_OTHER_ORG
            : null
    }
  }
  // An add: the trip's organization first, then the owner's pick, then the only one signed in.
  const wanted = linkedOrg ?? choice.picked
  const open = orgs.filter((entry) => !choice.taken?.includes(entry.orgId))
  const org =
    orgs.find((entry) => entry.orgId === wanted) ??
    (wanted == null && open.length === 1 ? open[0] : null)
  if (!org) {
    return open.length > 1
      ? { kind: 'pick', orgs: open }
      : { kind: 'connect', error: connect.status === 'failed' ? connect.error : null }
  }
  return org.expired ? { kind: 'expired', org } : { kind: 'turn-on', org }
}
