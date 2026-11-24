// A bot's Slack thread chat posting the owner's Orca messages back to the thread: who it starts on
// for, what each message's post came to, and what the chat shows of it, on desktop and phone alike.
import type { ConnectorAsker } from './connector-cloud-contract'
import type { ConnectorMessageAsker } from '../connector-message-asker'
import type { OtherPersonTypist } from '../agent-session/journal/agent-journal-typed-by'
import type {
  ExternalConversationLink,
  ExternalConversationOpener,
  SlackMirrorBlocked,
  SlackMirrorPost
} from './external-conversation-link'

/** The posts a link keeps, newest first by when they were made; older ones lose their badge. */
export const SLACK_MIRROR_KEPT_POSTS = 100

const MAX_OPENER_NAME = 80

/** Who began a conversation, from the delivery that started it. */
export function conversationOpener(asker: ConnectorAsker): ExternalConversationOpener {
  const name = asker.name?.slice(0, MAX_OPENER_NAME)
  return {
    role: asker.app ? 'member' : asker.role,
    ...(name ? { name } : {}),
    ...(asker.place.kind === 'direct_message' ? { dm: true as const } : {})
  }
}

/** A Slack thread or DM's own chat, which can post back. The bot's Chat (`bot-chat`), which answers
 *  whichever DM wrote last, never does: what the owner types there is theirs. */
export function slackMirrorAvailable(
  link: Pick<ExternalConversationLink, 'source' | 'bot' | 'externalId'>
): boolean {
  return (
    link.source === 'slack' && link.bot?.kind === 'bot' && slackPlaceOf(link.externalId) !== null
  )
}

/** A new chat posts back only when its owner began it and the bot's setting allows; threads and
 *  DMs others begin start off. A Slack Connect thread turns off at its first post (`mirrorExternal`). */
export function slackMirrorDefault(
  opener: ExternalConversationOpener,
  botSetting: boolean | undefined
): boolean {
  return opener.role === 'owner' && botSetting !== false
}

export type SlackMirrorGate = Pick<
  ExternalConversationLink,
  'mirror' | 'mirrorBlocked' | 'mirrorChosen' | 'mirrorExternal'
>

/** Whether the chat is set to post: on, not blocked, and not a thread known to be Slack Connect
 *  that the owner never turned on themselves. */
export function slackMirrorMayPost(link: SlackMirrorGate): boolean {
  return (
    link.mirror === true &&
    !link.mirrorBlocked &&
    (link.mirrorChosen === true || link.mirrorExternal !== true)
  )
}

/** Whether a message posts now: a default-on chat waits until the thread is known not to be
 *  Slack Connect (Q3), so an unread status never posts outside the workspace. */
export function slackMirrorPosts(link: SlackMirrorGate): boolean {
  return slackMirrorMayPost(link) && (link.mirrorChosen === true || link.mirrorExternal === false)
}

/** Slack's answer to a post, as what the chat can still do. */
export function slackMirrorBlockOf(error: string | null): SlackMirrorBlocked | null {
  if (error === 'thread_not_found' || error === 'is_archived') {
    return 'thread_unavailable'
  }
  return error === 'not_in_channel' ? 'not_in_channel' : null
}

/** The posts with one more (or, with null, one fewer), keeping the newest. */
export function withSlackMirrorPost(
  posts: Record<string, SlackMirrorPost> | undefined,
  itemId: string,
  post: SlackMirrorPost | null
): Record<string, SlackMirrorPost> {
  const next = { ...posts }
  if (post) {
    next[itemId] = post
  } else {
    delete next[itemId]
  }
  const entries = Object.entries(next)
  if (entries.length <= SLACK_MIRROR_KEPT_POSTS) {
    return next
  }
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b.at - a.at).slice(0, SLACK_MIRROR_KEPT_POSTS)
  )
}

type SlackPlace = { teamId: string; channelId: string; threadTs: string | null }

const SLACK_ID = /^[A-Z0-9]+$/
const SLACK_TS = /^\d+(?:\.\d+)?$/

/** A Slack conversation's team, channel and thread from its external id (`T:C:ts:UBOT` for a
 *  thread, `T:D:D:UBOT` for a DM); null for an id this build can't read. Group DMs never arrive: the
 *  app has no mpim scope. */
export function slackPlaceOf(externalId: string): SlackPlace | null {
  const parts = externalId.split(':')
  const [teamId, channelId] = parts
  if (!teamId || !channelId || !SLACK_ID.test(teamId) || !SLACK_ID.test(channelId)) {
    return null
  }
  const threadTs = SLACK_TS.test(parts[2] ?? '') ? parts[2]! : null
  return channelId.startsWith('D') || threadTs ? { teamId, channelId, threadTs } : null
}

/** Where a mirrored post opens: its thread (or DM) in Slack. */
export function slackThreadUrl(externalId: string): string | null {
  const place = slackPlaceOf(externalId)
  if (!place) {
    return null
  }
  const base = `https://app.slack.com/client/${place.teamId}/${place.channelId}`
  return place.threadTs ? `${base}/thread/${place.channelId}-${place.threadTs}` : base
}

/** The "You · Slack" tag's facts for a message posted to the thread from Orca: the owner's, or the
 *  other person's who typed it (a shared teammate). */
export function slackMirrorPostedAsker(
  link: Pick<ExternalConversationLink, 'externalId' | 'opener'>,
  typist?: OtherPersonTypist
): ConnectorMessageAsker {
  const url = slackThreadUrl(link.externalId)
  return {
    source: 'slack',
    ...(typist
      ? { userId: 'orca', name: typist.name, role: 'member' as const }
      : { userId: 'owner', role: 'owner' as const }),
    place: {
      kind: link.opener?.dm ? 'direct_message' : 'channel',
      id: slackPlaceOf(link.externalId)?.channelId ?? 'slack'
    },
    ...(url ? { url } : {})
  }
}

/** What the chat's Slack menu knows of the thread beyond the link, from the cloud's status. */
export type SlackMirrorThreadFacts = {
  channelName?: string
  external?: true
  customize?: boolean
}

/** One line of copy: its translation key, English text and values. */
export type SlackMirrorCopy = { key: string; text: string; values?: Record<string, string> }

/** Strips what would let a Slack name break the line it sits in. */
function plainName(name: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim()
}

function channelOf(
  link: Pick<ExternalConversationLink, 'place'>,
  facts?: SlackMirrorThreadFacts
): string | null {
  const name = plainName(facts?.channelName ?? link.place ?? '')
  return name ? (name.startsWith('#') ? name : `#${name}`) : null
}

export type SlackMirrorView = {
  on: boolean
  /** The switch can't be turned on: the thread is gone or the bot was removed. */
  blocked: SlackMirrorBlocked | null
  /** The under-row item. */
  label: SlackMirrorCopy
  /** Short form for narrow panes and the phone. */
  short: SlackMirrorCopy
  /** The menu's heading. */
  heading: SlackMirrorCopy
  /** Under the switch: who sees it, or why it is off. */
  detail: SlackMirrorCopy
  /** The app lacks the scope to post under the owner's name. */
  updateNeeded: boolean
}

/** Everything the under-row item and its menu say of a chat's Slack thread. */
export function slackMirrorView(
  link: Pick<
    ExternalConversationLink,
    'place' | 'opener' | 'mirror' | 'mirrorBlocked' | 'mirrorChosen' | 'mirrorExternal'
  >,
  botName: string,
  facts?: SlackMirrorThreadFacts
): SlackMirrorView {
  const blocked = link.mirrorBlocked ?? null
  const on = slackMirrorMayPost(link)
  const channel = channelOf(link, facts)
  const dm = link.opener?.dm === true
  const ownDm = dm && link.opener?.role === 'owner'
  const starter = plainName(link.opener?.name ?? '')
  const bot = { bot: plainName(botName) || 'the bot' }
  const where: SlackMirrorCopy = ownDm
    ? {
        key: 'components.native-chat.slackMirror.ownDm',
        text: 'Also posts to your DM with {{bot}}',
        values: bot
      }
    : dm
      ? starter
        ? {
            key: 'components.native-chat.slackMirror.theirDm',
            text: "Also posts to {{name}}'s DM with {{bot}}",
            values: { ...bot, name: starter }
          }
        : {
            key: 'components.native-chat.slackMirror.someonesDm',
            text: 'Also posts to a DM with {{bot}}',
            values: bot
          }
      : channel
        ? {
            key: 'components.native-chat.slackMirror.channel',
            text: 'Also posts to {{channel}} thread',
            values: { channel }
          }
        : {
            key: 'components.native-chat.slackMirror.thread',
            text: 'Also posts to the Slack thread'
          }
  const off: SlackMirrorCopy =
    blocked === 'thread_unavailable'
      ? {
          key: 'components.native-chat.slackMirror.offUnavailable',
          text: 'Only in Orca · thread unavailable'
        }
      : blocked === 'not_in_channel'
        ? {
            key: 'components.native-chat.slackMirror.offNotInChannel',
            text: 'Only in Orca · not in channel'
          }
        : { key: 'components.native-chat.slackMirror.off', text: 'Only in Orca' }
  const short: SlackMirrorCopy = dm
    ? { key: 'components.native-chat.slackMirror.shortDm', text: 'Slack DM' }
    : channel
      ? {
          key: 'components.native-chat.slackMirror.shortChannel',
          text: '{{channel}} thread',
          values: { channel }
        }
      : { key: 'components.native-chat.slackMirror.shortThread', text: 'Slack thread' }
  const heading: SlackMirrorCopy = dm
    ? { key: 'components.native-chat.slackMirror.headingDm', text: 'Slack DM' }
    : channel
      ? {
          key: 'components.native-chat.slackMirror.headingChannel',
          text: 'Slack thread in {{channel}}',
          values: { channel }
        }
      : { key: 'components.native-chat.slackMirror.headingThread', text: 'Slack thread' }
  const updateNeeded = facts?.customize === false
  return {
    on,
    blocked,
    label: on ? where : off,
    short,
    heading,
    detail: mirrorDetail(blocked, { dm, ownDm, channel, starter, bot, facts, updateNeeded }),
    updateNeeded
  }
}

function mirrorDetail(
  blocked: SlackMirrorBlocked | null,
  at: {
    dm: boolean
    ownDm: boolean
    channel: string | null
    starter: string
    bot: { bot: string }
    facts?: SlackMirrorThreadFacts
    updateNeeded: boolean
  }
): SlackMirrorCopy {
  if (blocked === 'thread_unavailable') {
    return {
      key: 'components.native-chat.slackMirror.detailUnavailable',
      text: 'This Slack thread was deleted or its channel archived.'
    }
  }
  if (blocked === 'not_in_channel') {
    return at.channel
      ? {
          key: 'components.native-chat.slackMirror.detailRemovedFrom',
          text: '{{bot}} was removed from {{channel}}.',
          values: { ...at.bot, channel: at.channel }
        }
      : {
          key: 'components.native-chat.slackMirror.detailRemoved',
          text: '{{bot}} was removed from the channel.',
          values: at.bot
        }
  }
  if (at.updateNeeded) {
    return {
      key: 'components.native-chat.slackMirror.detailFallback',
      text: 'Posts as {{bot}} with your name. Update in Slack to post under your name.',
      values: at.bot
    }
  }
  const values = { ...at.bot, channel: at.channel ?? '' }
  if (at.ownDm) {
    return {
      key: 'components.native-chat.slackMirror.detailOwnDm',
      text: "Your messages and {{bot}}'s replies. Only you see this DM. Tool calls and workers stay in Orca.",
      values
    }
  }
  if (at.dm) {
    return at.starter
      ? {
          key: 'components.native-chat.slackMirror.detailTheirDm',
          text: "Your messages and {{bot}}'s replies. {{name}} sees them in their DM. Tool calls and workers stay in Orca.",
          values: { ...values, name: at.starter }
        }
      : {
          key: 'components.native-chat.slackMirror.detailSomeonesDm',
          text: "Your messages and {{bot}}'s replies. The person in this DM sees them. Tool calls and workers stay in Orca.",
          values
        }
  }
  if (!at.channel) {
    return {
      key: 'components.native-chat.slackMirror.detailThread',
      text: "Your messages and {{bot}}'s replies. Everyone in the channel can see them. Tool calls and workers stay in Orca.",
      values
    }
  }
  return at.facts?.external
    ? {
        key: 'components.native-chat.slackMirror.detailExternal',
        text: "Your messages and {{bot}}'s replies. Everyone in {{channel}} can see them, including people outside your workspace. Tool calls and workers stay in Orca.",
        values
      }
    : {
        key: 'components.native-chat.slackMirror.detailChannel',
        text: "Your messages and {{bot}}'s replies. Everyone in {{channel}} can see them. Tool calls and workers stay in Orca.",
        values
      }
}
