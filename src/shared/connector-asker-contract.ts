// Who asked a bot, as Orca Cloud resolved them: the machine side's mirror of
// cloud/packages/connector-contract's asker (see connector-cloud-contract.ts).
import * as z from 'zod'

export const CONNECTOR_ASKER_PLACE_KINDS = [
  'direct_message',
  'group_message',
  'public_channel',
  'private_channel',
  'channel',
  'issue',
  'pull_request'
] as const
export type ConnectorAskerPlaceKind = (typeof CONNECTOR_ASKER_PLACE_KINDS)[number]

const PersonFields = {
  userId: z.string().min(1).max(128),
  name: z.string().min(1).max(200).optional()
}

/** What a bot reads before the request, each part under its own label. `bot` (a bot's post in the
 *  thread) and `more` (more was posted than fits) come only to a machine that lists threadCatchUp. */
export const ConnectorContextItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('earlier'), ...PersonFields, text: z.string() }),
  z.object({ kind: z.literal('no_access'), ...PersonFields, text: z.string() }),
  z.object({ kind: z.literal('issue'), text: z.string() }),
  z.object({ kind: z.literal('unreadable') }),
  z.object({
    kind: z.literal('bot'),
    name: z.string().min(1).max(200).optional(),
    text: z.string()
  }),
  z.object({ kind: z.literal('more') })
])
export type ConnectorContextItem = z.infer<typeof ConnectorContextItem>

// Mirrors cloud/packages/connector-contract's CONNECTOR_LIMITS for asker.earlierOwn.
const MAX_EARLIER_OWN_MESSAGES = 10
const MAX_EARLIER_OWN_TEXT = 4000
const MAX_EARLIER_OWN_FILES = 10
// The largest time a Date can show.
const MAX_EPOCH_MS = 8_640_000_000_000_000

/** One of the asker's own messages before a bare mention. Empty text with files or a share is still
 *  theirs; `cut`, `shared` and `filesMore` mark a part Orca doesn't carry. */
const ConnectorEarlierOwnMessage = z.object({
  text: z.string().max(MAX_EARLIER_OWN_TEXT),
  at: z.number().int().nonnegative().max(MAX_EPOCH_MS),
  messageRef: z.string().min(1).max(2048).optional(),
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().max(1024),
        type: z.string().optional(),
        size: z.number().int().nonnegative().optional()
      })
    )
    .max(MAX_EARLIER_OWN_FILES)
    .optional(),
  filesMore: z.literal(true).optional(),
  shared: z.literal(true).optional(),
  cut: z.literal(true).optional()
})

/** A bare mention's request, as the cloud chose it on the source's author id: the asker's own
 *  messages in the thread before the mention, after the bot's last post there, oldest first.
 *  `more`: they wrote more than these. */
export const ConnectorEarlierOwn = z.object({
  messages: z.array(ConnectorEarlierOwnMessage).min(1).max(MAX_EARLIER_OWN_MESSAGES),
  more: z.literal(true).optional()
})
export type ConnectorEarlierOwn = z.infer<typeof ConnectorEarlierOwn>

/** Who asked a bot, where, what they wrote and what came before it, as Orca Cloud resolved them.
 *  `role` was decided on `userId` (owner, or a member the owner added), never on `name`.
 *  `place.id`: a Slack channel id, a GitHub `owner/repo#number`, a Linear issue key. */
// The Orca bot that wrote a message on its person's behalf (its words, not theirs); dropped alone
// when unreadable. Its kind ('bot') is left unread: it has no other.
export const ConnectorAskerVia = z
  .object({ userId: z.string().min(1).max(128), name: z.string().min(1).max(200) })
  .optional()
  .catch(undefined)

export const ConnectorAsker = z.object({
  ...PersonFields,
  role: z.enum(['owner', 'member']),
  place: z.object({ kind: z.enum(CONNECTOR_ASKER_PLACE_KINDS), id: z.string().min(1).max(256) }),
  text: z.string().min(1),
  context: z.array(ConnectorContextItem),
  // Shown with the asker's tag: where they wrote it, and their picture. Unchecked here; see
  // readConnectorMessageAsker for the hosts either may name.
  url: z.string().min(1).max(2048).optional().catch(undefined),
  avatarUrl: z.string().min(1).max(2048).optional().catch(undefined),
  // The message itself as an action ref, which `orca bot reply --react` reacts on.
  messageRef: z.string().min(1).max(2048).optional().catch(undefined),
  // A bare mention's request; one this build can't read is dropped alone, and the bot then greets.
  earlierOwn: ConnectorEarlierOwn.optional().catch(undefined),
  via: ConnectorAskerVia,
  // Mirrors the contract's ViaAccountSchema (share-messages.ts): the shared Orca account their
  // login is linked to, when that share lets them ask.
  viaAccount: z.string().min(1).max(128).optional().catch(undefined),
  // Another Slack app on the bot's Who can ask wrote it, not a person: userId is its bot user.
  app: z.literal(true).optional().catch(undefined),
  // Orca's own lines on where it was asked (GitHub: the branch, how to post there): the agent reads
  // them after the message, and the chat doesn't show them.
  note: z.string().min(1).max(4000).optional().catch(undefined)
})
export type ConnectorAsker = z.infer<typeof ConnectorAsker>
