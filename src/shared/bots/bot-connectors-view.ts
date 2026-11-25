// `orca bot connectors`: per service, the tool a bot uses, who it acts as, whether it is signed in on
// this computer, and whether Orca Cloud wakes it there; with the workspaces it is in, as refs.
import { botLinearWorkspaces, botSlackApps, type Bot } from '../bot-types'
import { CONNECTOR_OFFER_NAMES, type ConnectorOfferSource } from './bot-connector-offer'
import type { GoogleAccountView, GoogleServiceReadiness } from '../google/google-connect-types'
import { GOOGLE_SERVICE_INFO } from '../google/google-scopes'
import { googleBotConnectState, type GoogleHostConnect } from '../google/google-bot-connect-state'
import {
  botGoogleAccess,
  botGoogleDefault,
  botMayUseGoogleAccount,
  googleEmailKey,
  type GoogleDefaultRead
} from '../google/google-bot-accounts'

// Read through the owner's own sign-in; Orca Cloud has no Azure DevOps events to wake a bot on.
type LocalOnlyConnectorSource = 'azure-boards'

export type BotConnectorService = {
  source: ConnectorOfferSource | LocalOnlyConnectorSource
  tool: string
  /** Who what the tool does shows as: the bot's owner, or the bot itself. */
  actsAs: 'owner' | 'bot'
  signedIn: boolean
  /** The one line to tell the owner when it isn't signed in. */
  gap?: string
  /** Connected to Orca Cloud, which wakes the bot there. */
  wakes: boolean
  /** A link the owner opens to approve what the bot's app newly needs. */
  approveUrl?: string
  /** Which accounts and services work, when that is more than signed in or not. */
  detail?: string
}

type RefView = { ref: string; label: string }
export type BotConnectorWorkspace = RefView & { source: string; places?: RefView[] }

export type BotConnectorsView = {
  bot: string
  services: BotConnectorService[]
  workspaces: BotConnectorWorkspace[]
  /** Why the workspaces couldn't be listed, when they couldn't. */
  workspacesNote?: string
}

export const GH_SIGNED_OUT = 'Run `gh auth login` on this computer.'
export const GH_MISSING = 'Install the GitHub CLI (gh) on this computer, then run `gh auth login`.'
export const AZURE_BOARDS_SIGNED_OUT =
  'Run `az login` on this computer, or set an Azure DevOps token for Orca.'
export const LINEAR_NO_KEY =
  'Connect Linear to your bot, or add a Linear API key in Settings › Integrations.'

// linear: a Linear API key or a Connect Linear login on this computer.
// google: the Google accounts connected on this computer; absent from hosts that report none.
// googleApp: whether this computer has a Google app (client) to sign in with.
// googleDefault: this computer's default as the host reads it: an account, none, or unreadable.
export type LocalSignIns = {
  gh: 'signed-in' | 'signed-out' | 'missing'
  linear: boolean
  google?: readonly GoogleAccountView[]
  googleApp?: boolean
  googleDefault?: GoogleDefaultRead
  /** Absent from hosts older than `orca azure-boards`. */
  azureBoards?: boolean
}

const OFFER_GOOGLE = '`orca bot connectors --offer google`'
const GOOGLE_HOST_GAPS: Record<Exclude<GoogleHostConnect, 'connected'>, string> = {
  'no-app': `Google isn't set up on this computer; ${OFFER_GOOGLE} asks your owner to set it up.`,
  'signed-out': `Nobody is signed in to Google on this computer; ${OFFER_GOOGLE} asks your owner to sign in.`,
  reconnect: `Google access ended; ${OFFER_GOOGLE} asks your owner to reconnect.`
}

const GOOGLE_STATES: Record<GoogleServiceReadiness['state'], string> = {
  ready: 'ready',
  'needs-permission': 'not allowed',
  'api-disabled': 'API off',
  'blocked-by-admin': 'blocked by admin',
  error: 'not working'
}

/** Google's row: the owner's accounts on this computer, if the owner turned Google on for this bot. */
function googleService(
  bot: Pick<Bot, 'google' | 'googleAccounts'>,
  hostAccounts: readonly GoogleAccountView[],
  app: boolean,
  computerDefault: GoogleDefaultRead
): BotConnectorService {
  // Only the accounts the bot may use, and the default its calls without --account go to: the
  // host's rule, so an unreadable default marks none.
  const access = botGoogleAccess(bot)
  const accounts = hostAccounts.filter((account) => botMayUseGoogleAccount(access, account.email))
  const read = botGoogleDefault(access, computerDefault)
  const defaultAccount = 'email' in read ? read.email : null
  const isDefault = (account: GoogleAccountView): boolean =>
    defaultAccount !== null && googleEmailKey(account.email) === defaultAccount
  const connected = accounts.filter((account) => account.status === 'connected')
  const { allowed, host } = googleBotConnectState({
    allowed: bot.google === true,
    client: app,
    accounts
  })
  const gap = !allowed
    ? `Run ${OFFER_GOOGLE} to ask your owner.`
    : host === 'connected'
      ? undefined
      : accounts.length === 0 && hostAccounts.length > 0
        ? `None of the Google accounts on this computer is chosen for you; ${OFFER_GOOGLE} asks your owner.`
        : GOOGLE_HOST_GAPS[host]
  // A signed-out default stays listed: calls without --account still go to it, and fail.
  const signedOutDefault = accounts.find(
    (account) => isDefault(account) && account.status !== 'connected'
  )
  const detail = [
    ...(signedOutDefault
      ? [`${signedOutDefault.email} (default): signed out, needs reconnecting`]
      : []),
    ...connected.map(
      (account) =>
        `${account.email}${isDefault(account) ? ' (default)' : ''}: ${account.services
          .map(
            (service) =>
              `${GOOGLE_SERVICE_INFO[service.service].label} ${GOOGLE_STATES[service.state]}`
          )
          .join(', ')}`
    )
  ].join('; ')
  return {
    source: 'google',
    tool: 'orca gmail|calendar|contacts',
    actsAs: 'owner',
    signedIn: gap === undefined,
    ...(gap ? { gap } : {}),
    wakes: false,
    ...(detail ? { detail } : {})
  }
}

const SLACK_NO_APP = 'Run `orca bot connectors --offer slack` to show your owner a Connect card.'
const SLACK_NOT_INSTALLED =
  "Your Slack app isn't installed. Ask your owner to finish its setup, or remove it, under Slack on your page in Orca."

/** What Orca Cloud says a bot can act through; Slack is listed once its app is installed. */
export type CloudSource = { source: string; approveUrl?: string }

/**
 * Each service's row, from the bot's links and what this computer is signed in to. `cloud`: Orca
 * Cloud's sources, when it answered; without them, the Slack app this computer set up stands.
 */
export function botConnectorServices(
  bot: Pick<
    Bot,
    'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github' | 'google' | 'googleAccounts'
  >,
  local: LocalSignIns,
  cloud?: readonly CloudSource[]
): BotConnectorService[] {
  const hasApp = botSlackApps(bot).length > 0
  const cloudSlack = cloud?.find((entry) => entry.source === 'slack')
  // A created app whose install Slack refused or nobody finished is not connected.
  const slack = cloud ? cloudSlack !== undefined : hasApp
  return [
    {
      source: 'github',
      tool: 'gh',
      actsAs: 'owner',
      signedIn: local.gh === 'signed-in',
      ...(local.gh === 'signed-in'
        ? {}
        : { gap: local.gh === 'missing' ? GH_MISSING : GH_SIGNED_OUT }),
      wakes: bot.github !== null
    },
    {
      source: 'linear',
      tool: 'orca linear',
      actsAs: 'owner',
      signedIn: local.linear,
      ...(local.linear ? {} : { gap: LINEAR_NO_KEY }),
      wakes: botLinearWorkspaces(bot).length > 0
    },
    {
      source: 'slack',
      tool: 'orca slack',
      actsAs: 'bot',
      signedIn: slack,
      ...(slack ? {} : { gap: hasApp ? SLACK_NOT_INSTALLED : SLACK_NO_APP }),
      wakes: slack,
      ...(cloudSlack?.approveUrl ? { approveUrl: cloudSlack.approveUrl } : {})
    },
    ...(local.google
      ? [
          googleService(
            bot,
            local.google,
            local.googleApp === true,
            local.googleDefault ?? { email: null }
          )
        ]
      : []),
    ...(local.azureBoards === undefined
      ? []
      : [
          {
            source: 'azure-boards' as const,
            tool: 'orca azure-boards',
            actsAs: 'owner' as const,
            signedIn: local.azureBoards,
            ...(local.azureBoards ? {} : { gap: AZURE_BOARDS_SIGNED_OUT }),
            wakes: false
          }
        ])
  ]
}

function serviceLines(service: BotConnectorService, botName: string): string[] {
  const name =
    service.source === 'azure-boards' ? 'Azure Boards' : CONNECTOR_OFFER_NAMES[service.source]
  const as = service.actsAs === 'owner' ? 'as your owner' : `as ${botName}`
  const state = service.signedIn
    ? service.actsAs === 'bot'
      ? 'Connected.'
      : 'Signed in.'
    : `${service.actsAs === 'bot' ? 'Not connected.' : 'Not signed in.'} ${service.gap ?? ''}`.trim()
  const wakes =
    service.source === 'slack' || service.source === 'google' || service.source === 'azure-boards'
      ? null
      : service.wakes
        ? `  Connected: Orca wakes ${botName} on @mentions and watched events here.`
        : `  Not connected for wakes: \`orca bot connectors --offer ${service.source}\` to be @mentioned or to watch.`
  return [
    `${name}: \`${service.tool}\`, ${as}. ${state}`,
    ...(service.detail ? [`  ${service.detail}`] : []),
    ...(wakes ? [wakes] : []),
    ...(service.approveUrl ? [`  Ask your owner to approve: ${service.approveUrl}`] : [])
  ]
}

export function formatBotConnectors(view: BotConnectorsView): string {
  const places = view.workspaces.flatMap((workspace) => [
    `${workspace.ref}  ${workspace.source}: ${workspace.label}`,
    ...(workspace.places ?? []).map((place) => `  ${place.ref}  ${place.label}`)
  ])
  return [
    ...view.services.flatMap((service) => serviceLines(service, view.bot)),
    '',
    `Where ${view.bot} is (refs for automations):`,
    ...(places.length > 0 ? places : [view.workspacesNote ?? 'Nowhere yet.'])
  ].join('\n')
}
