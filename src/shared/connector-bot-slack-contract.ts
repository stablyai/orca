import { lazyZodSchema } from './schema/lazy-zod-schema'
// Mirror of cloud/packages/connector-contract/src/slack-{grant,bot}-messages.ts for the desktop's reads.
import * as z from 'zod'
import { optionalConnectorAvatarUrl } from './connector-message-asker'
import type { BotMascotId } from './bot-avatar'

/** Slack's configuration refresh tokens; the cloud spends one at once and keeps only its rotation. */
export const SLACK_CONFIG_REFRESH_TOKEN_PREFIX = 'xoxe-'
export const SLACK_CONFIG_REFRESH_TOKEN_MAX_LENGTH = 2048

// Slack shows two tokens side by side; the access token is the one Orca can't keep using.
const SLACK_CONFIG_ACCESS_TOKEN_PREFIX = 'xoxe.xoxp-'
const TOKEN_SHAPE = /^[\w.-]+$/

/** What copied or pasted text is, when it is one of Slack's two configuration tokens. */
export function slackConfigTokenKind(text: string): 'refresh' | 'access' | null {
  const value = text.trim()
  if (!TOKEN_SHAPE.test(value)) {
    return null
  }
  if (value.startsWith(SLACK_CONFIG_ACCESS_TOKEN_PREFIX)) {
    return 'access'
  }
  return value.startsWith(SLACK_CONFIG_REFRESH_TOKEN_PREFIX) ? 'refresh' : null
}

// PUT `${bots}/<bot id>/avatar`: a mascot by id, or an upload's PNG (base64) and the version naming it.
export type ConnectorBotAvatarRequest =
  | { v: 1; kind: 'mascot'; id: BotMascotId }
  | { v: 1; kind: 'upload'; version: string; png: string }

export const ConnectorSlackGrantResponse = lazyZodSchema(() =>
  z.object({
    teamId: z.string().min(1)
  })
)

// Slack's install link for the bot's app; each one supersedes the last. `expiresAt` (ms) is when it
// stops working; an older cloud leaves it out.
export const ConnectorBotSlackAppResponse = lazyZodSchema(() =>
  z.object({
    appId: z.string().min(1),
    authorizeUrl: z.string().url(),
    expiresAt: z.number().int().positive().optional()
  })
)
export type ConnectorBotSlackAppResponse = z.infer<typeof ConnectorBotSlackAppResponse>

// A paired computer's one-time code that lets another signed-in Orca account create its bot's app.
export const ConnectorBotSlackHandOffResponse = lazyZodSchema(() =>
  z.object({
    code: z.string().min(1),
    expiresAt: z.number().int().positive()
  })
)
export type ConnectorBotSlackHandOffResponse = z.infer<typeof ConnectorBotSlackHandOffResponse>

// created: waits for its Install click or an admin's approval. uncertain: Slack may hold an app Orca
// has no secrets for; setting up again finishes it or makes a new one. grant_expired: as uncertain,
// with no grant left to continue.
export const ConnectorBotSlackState = lazyZodSchema(() =>
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_created') }),
    z.object({ state: z.literal('uncertain'), teamId: z.string() }),
    z.object({ state: z.literal('grant_expired'), teamId: z.string() }),
    z.object({
      state: z.literal('created'),
      teamId: z.string(),
      appId: z.string(),
      // Why the last install link was refused; 'other_user': approved by a Slack user other than the
      // one whose token made the app. Any other value reads as none.
      oauthFailure: z.string().optional()
    }),
    z.object({
      state: z.literal('installed'),
      teamId: z.string(),
      appId: z.string(),
      botUserId: z.string(),
      installerUserId: z.string(),
      // Left out when Slack could not say, or by a cloud that predates them.
      teamName: z.string().optional(),
      installerName: z.string().optional(),
      // The app's manifest predates this cloud's: setting it up again adds the new scopes and events.
      updateNeeded: z.literal(true).optional(),
      // The app works as it is, yet predates permissions this cloud's manifest asks for: setting it up
      // again grants them. Offered, never asked for.
      updateAvailable: z.literal(true).optional(),
      // What messages typed at the bot's computer post as here, and a change waiting on the Slack
      // approval of whoever set it up; an older cloud leaves them out (no choice to offer).
      postAs: z.enum(['person', 'computer']).optional(),
      postAsPending: z.enum(['person', 'computer']).optional(),
      // What each choice shows as: the bot's account's Slack name and picture (left out without its
      // Slack link) and the computer's name as Orca shows it.
      poster: z.object({ name: z.string(), avatarUrl: optionalConnectorAvatarUrl }).optional(),
      computerName: z.string().optional()
    })
  ])
)
export type ConnectorBotSlackState = z.infer<typeof ConnectorBotSlackState>

// GET `?team=`: that workspace's state, or with none the bot's first. `teams` lists every workspace's,
// from a cloud with `slack.teams`.
export const ConnectorBotSlackStateResponse = lazyZodSchema(() =>
  ConnectorBotSlackState.and(z.object({ teams: z.array(ConnectorBotSlackState).optional() }))
)
export type ConnectorBotSlackStateResponse = z.infer<typeof ConnectorBotSlackStateResponse>

/** The bot's Slack in one workspace; with no team, its first. An older cloud lists no teams. */
export function slackTeamState(
  slack: ConnectorBotSlackStateResponse,
  teamId: string | undefined
): ConnectorBotSlackState {
  if (teamId === undefined) {
    return slack
  }
  const listed = slack.teams?.find((team) => 'teamId' in team && team.teamId === teamId)
  return (
    listed ??
    ('teamId' in slack && slack.teamId === teamId ? slack : { state: 'not_created' as const })
  )
}

/** Slack's own link to an app's direct messages in its workspace: it opens the Slack app there. */
export function slackAppMessagesUrl(appId: string, teamId: string): string {
  return `https://slack.com/app_redirect?${new URLSearchParams({ app: appId, team: teamId }).toString()}`
}

export type SlackPostAs = 'person' | 'computer'

// POST `${bots}/<id>/slack/post-as`: applied at once (the setup's own pick, naming its install link's
// state), or an install link whoever set the bot up approves to apply it. `cancel` answers nothing.
export type ConnectorBotSlackPostAsRequest =
  | { v: 1; teamId: string; postAs: SlackPostAs; setupState?: string }
  | { v: 1; teamId: string; cancel: true }
export const ConnectorBotSlackPostAsResponse = lazyZodSchema(() =>
  z.union([z.object({ applied: z.literal(true) }), ConnectorBotSlackAppResponse])
)
export type ConnectorBotSlackPostAsResponse = z.infer<typeof ConnectorBotSlackPostAsResponse>

// complete is false when the workspace is too large to read whole, so someone may be missing.
export const ConnectorBotSlackMembersResponse = lazyZodSchema(() =>
  z.object({
    members: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        // Left out when they have none, or by a cloud that predates it.
        avatarUrl: optionalConnectorAvatarUrl,
        // Another Slack app's bot user, not a person; its name already says "(app)".
        app: z.literal(true).optional().catch(undefined)
      })
    ),
    complete: z.boolean()
  })
)
export type ConnectorBotSlackMembersResponse = z.infer<typeof ConnectorBotSlackMembersResponse>

/** A bot-Slack call's answer as the renderer sees it: the cloud's error code, or one of the desktop's. */
export type BotSlackResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A bare 404 on `${slack}/connect`: a cloud from before Sign in with Slack. */
export const BOT_SLACK_SIGN_IN_OFF = 'slack_sign_in_off'

/** The desktop's own codes, beside the cloud's (grant_expired, unknown_bot, wrong_workspace, …). */
export const BOT_SLACK_DESKTOP_ERRORS = {
  signedOut: 'signed_out',
  unreachable: 'cloud_unreachable',
  failed: 'cloud_error'
} as const
