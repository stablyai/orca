// The Slack mirror routes (`slack.mirror`): the owner's Orca-typed messages posted into the chat's
// Slack thread under their name. Mirror of cloud/packages/connector-contract's slack-mirror messages.
import * as z from 'zod'
import { CONNECTOR_PATHS, type ConnectorConversation } from './connector-cloud-contract'
import type { ConnectorCloudFeature } from '../connector-cloud-features'

export const SLACK_MIRROR_FEATURE = 'slack.mirror' satisfies ConnectorCloudFeature

export function slackMirrorPath(
  botId: string,
  route: '' | 'files' | 'update' | 'delete' | 'status'
): string {
  const base = `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/mirror`
  return route ? `${base}/${route}` : base
}

export const SLACK_MIRROR_MAX_FILES = 10

/** POST `…/mirror`: the owner's words as typed (the cloud converts and escapes them); one
 *  clientMessageId posts once. */
export type SlackMirrorPostBody = {
  v: 1
  clientMessageId: string
  conversation: ConnectorConversation
  text: string
  /** fileIds staged under this clientMessageId by `…/mirror/files`. */
  files?: string[]
  /** Who typed it. host: at the bot's computer (the cloud posts as its account's person, or the
   *  computer as the install says). account: a paired device on that Orca account. computer: a
   *  device that named none. An agent's posts as the bot. slackUserId is ignored. */
  author: {
    orcaName: string
    slackUserId?: string
    agent?: true
    typist?: SlackMirrorTypist
  }
}

export type SlackMirrorTypist =
  | { kind: 'host' }
  | { kind: 'account'; name: string }
  | { kind: 'computer' }

/** POST `…/mirror/files`: one attachment, staged before the post that names it. */
export type SlackMirrorFileBody = {
  v: 1
  clientMessageId: string
  fileId: string
  conversation: ConnectorConversation
  file: { name: string; data: string }
}

export type SlackMirrorUpdateBody = {
  v: 1
  clientMessageId: string
  conversation: ConnectorConversation
  text: string
}

export type SlackMirrorDeleteBody = {
  v: 1
  clientMessageId: string
  conversation: ConnectorConversation
}

export const SlackMirrorPostResponse = z.object({ ts: z.string().min(1) })

/** The cloud's refusals (409, 429, 503); a code this build doesn't know reads as permanent. */
export const SLACK_MIRROR_ERRORS = [
  'thread_not_found',
  'is_archived',
  'not_in_channel',
  'missing_scope',
  'file_too_large',
  'rate_limited',
  'transient',
  'not_found',
  // The named fileIds are no longer staged.
  'files_expired',
  // Update or delete after Delete from Slack, or a post reusing its id.
  'deleted',
  'not_installed',
  // Any other refusal from Slack.
  'slack_refused'
] as const
export type SlackMirrorError = (typeof SLACK_MIRROR_ERRORS)[number]

/** GET `…/mirror/status`: what the chat's Slack menu says of the thread, cached by the cloud. */
export const SlackMirrorStatus = z.object({
  channelName: z.string().min(1).max(200).optional().catch(undefined),
  external: z.literal(true).optional().catch(undefined),
  archived: z.literal(true).optional().catch(undefined),
  notInChannel: z.literal(true).optional().catch(undefined),
  missing: z.literal(true).optional().catch(undefined),
  dm: z.literal(true).optional().catch(undefined),
  // The app has chat:write.customize (manifest rev 5): posts carry the owner's name and picture.
  customize: z.boolean().catch(false)
})
export type SlackMirrorStatus = z.infer<typeof SlackMirrorStatus>
