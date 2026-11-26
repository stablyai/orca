// Mirror of cloud/packages/connector-contract/src/action-messages.ts for the machine side.
import * as z from 'zod'

// POST {v:1, botId, verb, ref?, args}: a bot reacts, reads, posts, edits, deletes, finds, checks or sets in a source.
export const CONNECTOR_ACTIONS_PATH = '/v1/connector/actions'

/** Connector calls that post as a bot chat and say whom its turn acts for: the CLI sends its session
 *  and the host verifies it, so a chat can only speak for its own turn. A reaction too: the host
 *  tells the cloud it is the owner's only for a chat it verified. */
export const CONNECTOR_POST_METHOD_NAMES = [
  'connector.act',
  'connector.reply',
  'connector.react',
  'connector.leaveThread'
] as const

// A cloud without edit, delete or attach refuses them itself, as unsupported; set goes only to a cloud listing `set`.
export const CONNECTOR_ACTION_VERBS = [
  'react',
  'read',
  'post',
  'edit',
  'delete',
  'find',
  'check',
  'attach',
  'set',
  // Slack's own surfaces; sent only to a cloud listing `slack.tools`.
  'pin',
  'canvas',
  'list',
  'scheduled'
] as const
export type ConnectorActionVerb =
  | (typeof CONNECTOR_ACTION_VERBS)[number]
  | 'capabilities'
  // A reply's file into the thread that woke the run (`orca bot reply --file`).
  | 'reply'
  // Sent only to a cloud listing `places`.
  | 'places'

// A whole workspace as a place (linear:<org>:workspace), which only a cloud listing `places` reads.
const WORKSPACE_REF = /^[a-z]+:[^:\s]+:workspace$/
export const isConnectorWorkspaceRef = (value: string): boolean => WORKSPACE_REF.test(value.trim())

// The most files one `orca bot reply` posts with its words.
export const CONNECTOR_REPLY_MAX_FILES = 10
// The most buttons one `orca bot reply` offers, and the longest label each takes (Slack's own cap).
export const CONNECTOR_REPLY_MAX_CHOICES = 10
export const CONNECTOR_REPLY_CHOICE_MAX_CHARS = 75

// A file the CLI uploads itself: its name and exact size, which the source's upload slot is cut for.
// No Orca cap; the source's own limits apply.
export const ConnectorUpload = z
  .object({
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type ConnectorUpload = z.infer<typeof ConnectorUpload>

const SEARCH_NAME = z.string().trim().min(1).max(100)
// state: a state's name, or `open` for any not done or canceled.
export const ConnectorSearch = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    state: SEARCH_NAME.optional(),
    assignee: SEARCH_NAME.optional(),
    label: SEARCH_NAME.optional()
  })
  .strict()

// set: an issue's fields by the names a person uses; null clears one. Sent only to a cloud listing `set`.
export const CONNECTOR_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export const ConnectorFields = z
  .object({
    state: SEARCH_NAME.optional(),
    assignee: SEARCH_NAME.nullable().optional(),
    delegate: SEARCH_NAME.nullable().optional(),
    priority: z.enum(CONNECTOR_PRIORITIES).optional(),
    addLabels: z.array(SEARCH_NAME).min(1).max(10).optional(),
    removeLabels: z.array(SEARCH_NAME).min(1).max(10).optional(),
    estimate: z.number().int().min(0).max(1000).nullable().optional()
  })
  .strict()

export const ConnectorActionArgs = z
  .object({
    emoji: z.string().min(1).max(100).optional(),
    remove: z.literal(true).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().min(1).max(2048).optional(),
    text: z.string().min(1).max(40_000).optional(),
    join: z.literal(true).optional(),
    // Minted once by the CLI, so the host's retries post at most once.
    postId: z.string().min(1).max(128).optional(),
    // post: when to post it (epoch seconds); sent only to a cloud listing `post.schedule`.
    postAt: z.number().int().positive().optional(),
    // list: its items, one line each, top to bottom.
    items: z.array(z.string().trim().min(1).max(500)).min(1).max(50).optional(),
    // scheduled: the id of one scheduled post to cancel; without it, they are listed.
    cancel: z.string().min(1).max(64).optional(),
    // read: the id of a file on the message read, to download it.
    download: z.string().min(1).max(64).optional(),
    // reply and attach, with stage: a file the CLI uploads itself, straight to the source, to the
    // URL the answer gives. Sent only to a cloud listing `files.direct`.
    upload: ConnectorUpload.optional(),
    // reply and attach: hold the uploaded file for the post that names its postId in `files`.
    stage: z.literal(true).optional(),
    // reply and attach: the postIds of files staged for it, posted with its text as one post.
    files: z.array(z.string().min(1).max(128)).min(1).max(CONNECTOR_REPLY_MAX_FILES).optional(),
    // reply: a button for each under its text (Slack); sent only to a cloud listing `reply.choices`.
    choices: z
      .array(z.string().trim().min(1).max(CONNECTOR_REPLY_CHOICE_MAX_CHARS))
      .min(1)
      .max(CONNECTOR_REPLY_MAX_CHOICES)
      .optional(),
    // read, with download: answer a link the CLI streams the bytes from. Sent only to a cloud listing
    // `files.direct`.
    stream: z.literal(true).optional(),
    // find: each match as what a rule or result names; sent only to a cloud listing `refs`.
    of: z.enum(['place', 'subject']).optional(),
    // find: the workspace (a ref from `orca bot connectors`) to look a person up in.
    workspace: z.string().min(1).max(2048).optional(),
    // find: what in a place matches words and filters; sent only to a cloud listing `find.search`.
    search: ConnectorSearch.optional(),
    fields: ConnectorFields.optional(),
    // post: a title makes a post to a team a new issue there, with `fields`, under `parent` (an issue
    // key, link or ref) when given. Sent only to a cloud listing `create`.
    title: z.string().trim().min(1).max(255).optional(),
    parent: z.string().min(1).max(2048).optional()
  })
  .strict()
export type ConnectorActionArgs = z.infer<typeof ConnectorActionArgs>

// The host passes the cloud's result on as it is, so a newer cloud's fields reach the CLI.
export const ConnectorActionResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.looseObject({}) }),
  z.object({
    ok: z.literal(false),
    refusal: z.string().min(1),
    message: z.string(),
    reason: z.string().optional(),
    scope: z.string().optional()
  })
])
export type ConnectorActionResponse = z.infer<typeof ConnectorActionResponse>

/** Why `connector.act` refused before the cloud acted; the cloud's own refusals come back as results. */
export const CONNECTOR_ACT_ERROR_CODES = [
  'not_a_bot_session',
  'connector_not_connected',
  'cloud_lacks_actions',
  'cloud_lacks_places',
  'cloud_lacks_search',
  'cloud_lacks_schedule',
  'cloud_lacks_slack_tools',
  'cloud_lacks_set',
  'cloud_lacks_create',
  // `bot reply` with several files, to a cloud that posts one file a message.
  'cloud_lacks_reply_files',
  // A file to attach or download, to a cloud that can't hand the bytes straight to this machine.
  'cloud_lacks_direct_files',
  // `bot reply --choice`, to a cloud that can't put buttons on a reply.
  'cloud_lacks_reply_choices',
  // A post whose answer was lost after every retry: it may have posted.
  'connector_post_unknown',
  // A set whose answer was lost: it may have changed the issue.
  'connector_set_unknown',
  'connector_unavailable',
  'bot_not_in_cloud',
  'connector_invalid_request',
  'connector_refused',
  // A look-around run asked for something other than a read.
  'look_around_reads_only',
  // `bot reply --react` in a run no message woke, or where reactions aren't available.
  'no_waking_message',
  // `bot reply --leave-thread` outside a Slack thread the bot follows, from a turn not running or not
  // a person's, or whose leave couldn't be saved.
  'not_a_thread',
  'leave_refused_stale',
  'leave_refused_mixed',
  'leave_unavailable',
  'thread_mute_not_saved',
  // A leave whose save's outcome is unknown: it may have taken.
  'leave_unconfirmed'
] as const
export type ConnectorActErrorCode = (typeof CONNECTOR_ACT_ERROR_CODES)[number]
