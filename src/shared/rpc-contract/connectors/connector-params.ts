import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { ConnectorReview } from '../../connector-review-contract'
import { CONNECTOR_ACTION_VERBS, ConnectorActionArgs } from '../../connector-action-contract'

/** Why `connector.reply` refused; connector_unavailable comes after the host's own retries. */
export const CONNECTOR_REPLY_ERROR_CODES = [
  'not_a_cloud_conversation',
  'no_current_turn',
  'connector_not_connected',
  'not_this_hosts_thread',
  'connector_unavailable',
  // A bot's Chat, which answers whichever direct message wrote last; its final message still posts.
  'bot_chat_reply',
  // The chat's conversation names a bot that is gone, off, or lives in another home.
  'not_this_bots_conversation',
  // Asked with pagesAsFiles: the text holds a whole HTML page, which Slack gets as an .html file.
  'html_document_as_file'
] as const

export const CONNECTOR_REPLY_HTML_PAGE_AS_FILE =
  'html_document_as_file' satisfies (typeof CONNECTOR_REPLY_ERROR_CODES)[number]

// What a reply answers when its host can't post for anyone: an SSH relay, an older host, or connectors off or signed out.
export const CONNECTOR_REPLY_UNAVAILABLE =
  "Replies aren't available from this host yet; the agent's final message is posted to the thread when the turn ends."

const ReplyText = {
  replyId: z.string().min(1, 'Missing reply id'),
  text: z.string().min(1, 'Missing text'),
  // Inline notes on the pull request the conversation is on; elsewhere they follow the text.
  review: ConnectorReview.optional(),
  // The caller can send a whole HTML page as a file; only then may Slack text holding one be refused.
  pagesAsFiles: z.literal(true).optional()
}

/** An agent's reply to its conversation's thread, from the pane or native chat it runs in; one replyId posts at most once. */
export const ConnectorReply = lazyZodSchema(() =>
  z.union([
    z.object({ paneKey: z.string().min(1, 'Missing pane key'), ...ReplyText }),
    z.object({ sessionId: z.string().min(1, 'Missing session id'), ...ReplyText })
  ])
)

/** A bot's shared verb in a source, from one of its chats; the cloud reads the ref, the host only who asks. */
export const ConnectorAct = lazyZodSchema(() =>
  z.object({
    sessionId: z.string().min(1, 'Missing session id'),
    verb: z.enum([...CONNECTOR_ACTION_VERBS, 'capabilities', 'places', 'reply']),
    ref: z.string().min(1).max(2048).optional(),
    args: ConnectorActionArgs.default({})
  })
)

/** `orca bot reply --react`: an emoji on the message that woke the calling bot's run. */
export const ConnectorReact = lazyZodSchema(() =>
  z.object({
    sessionId: z.string().min(1, 'Missing session id'),
    emoji: z.string().min(1).max(100)
  })
)

export const ConnectorLeaveThread = lazyZodSchema(() =>
  z.object({
    sessionId: z.string().min(1, 'Missing session id')
  })
)

const MirrorChat = { sessionId: z.string().min(1, 'Missing session id') }

/** A bot's Slack thread chat: post the owner's next messages there too, or keep them in Orca. */
export const ConnectorSlackMirrorSet = lazyZodSchema(() =>
  z.object({ ...MirrorChat, on: z.boolean() })
)

/** One Orca-typed message's post to the thread: Retry, Dismiss or Delete from Slack. */
export const ConnectorSlackMirrorPost = lazyZodSchema(() =>
  z.object({
    ...MirrorChat,
    itemId: z.string().min(1, 'Missing item id'),
    action: z.enum(['retry', 'dismiss', 'delete'])
  })
)

/** What the cloud says of the chat's thread for its menu. */
export const ConnectorSlackMirrorStatus = lazyZodSchema(() => z.object(MirrorChat))
