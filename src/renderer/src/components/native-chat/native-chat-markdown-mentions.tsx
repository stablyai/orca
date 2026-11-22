import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import type { CommentMarkdownExtension } from '@/components/comment-markdown/CommentMarkdown'
import { botGroupMentionSegments } from '../../../../shared/bots/bot-group-mentions'
import {
  BOT_CHAT_MENTION_PREFIX,
  botMentionTokens
} from '../../../../shared/bots/bot-mention-context'
import { BOT_ADDRESS_PREFIX } from '../../../../shared/bot-roster'
import {
  SLACK_MENTION_HREF,
  type SlackPeople
} from '../../../../shared/connectors/slack-message-markup'
import { showSlackMentionTokens } from '../../../../shared/connectors/slack-mention-tokens'

/** Room member names whose `@Name` mentions render as chips in this chat's messages. */
export const NativeChatMentionNamesContext = createContext<readonly string[] | null>(null)

const NO_NAMES: readonly string[] = []

/** The names to chip, or none at all; text holding a picked bot's token chips it with no names. */
export function withBoundBotMentions(
  names: readonly string[] | null,
  content: string
): readonly string[] | null {
  if (names?.length) {
    return names
  }
  return content.includes(`](${BOT_ADDRESS_PREFIX}`) ||
    content.includes(`](${BOT_CHAT_MENTION_PREFIX}`)
    ? NO_NAMES
    : null
}

/** A picked chat's current title in a sent message, looked up by id; a chat gone from the bot's list
 *  shows by its id instead. Absent where the chat's bots aren't known. */
export const NativeChatBotChatTitleContext = createContext<
  ((botId: string, chatId: string) => ReactNode) | null
>(null)

/** How a chat no title can be found for reads: by the start of its id, never dropped. */
export function botChatIdLabel(chatId: string): string {
  return `chat ${chatId.slice(0, 6)}`
}

/** The Slack people this chat knows; with them, Slack's `<@U…>` tokens in its text draw as names. */
export const NativeChatSlackPeopleContext = createContext<SlackPeople | null>(null)

/** Whether `@everyone` is a chip too: a group's, never a bot's own chat. */
export const NativeChatMentionEveryoneContext = createContext(true)

// Hast property sanitize must let through to the span renderer.
const MENTION_PROPERTY = 'dataOrcaMention'
const BOT_CHAT_PROPERTY = 'dataOrcaBotChat'
const SKIPPED = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'html',
  'math',
  'inlineMath'
])

type MarkdownNode = {
  type: string
  value?: string
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, string> }
  children?: MarkdownNode[]
}

function mentionNode(text: string, chat?: string): MarkdownNode {
  return {
    type: 'text',
    value: text,
    data: {
      hName: 'span',
      hProperties: { [MENTION_PROPERTY]: 'true', ...(chat ? { [BOT_CHAT_PROPERTY]: chat } : {}) }
    }
  }
}

function mentionNodes(value: string, names: readonly string[], everyone: boolean): MarkdownNode[] {
  return botGroupMentionSegments(value, names, everyone).map((segment) =>
    segment.mention ? mentionNode(segment.text) : { type: 'text', value: segment.text }
  )
}

// `[Bot: <name>](bot:<id>)`, a bot picked in a workspace chat, parses as a link; it shows as its chip,
// its name read from the source as the host reads it.
function pickedBot(node: MarkdownNode, source: string): MarkdownNode | null {
  const { start, end } = node.position ?? {}
  if (node.type !== 'link' || start?.offset === undefined || end?.offset === undefined) {
    return null
  }
  const [token] = botMentionTokens(source.slice(start.offset, end.offset))
  if (!token) {
    return null
  }
  return token.chatId
    ? mentionNode(`@${token.name} › ${botChatIdLabel(token.chatId)}`, `${token.id}/${token.chatId}`)
    : mentionNode(`@${token.name}`)
}

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join('') ?? ''
}

// A Slack message's drawn form writes each mention as a link to the marker; its text is the label.
function slackMention(node: MarkdownNode & { url?: string }): MarkdownNode | null {
  return node.type === 'link' && node.url === SLACK_MENTION_HREF
    ? mentionNode(plainText(node))
    : null
}

function splitMentions(
  node: MarkdownNode,
  names: readonly string[],
  everyone: boolean,
  source: string,
  slackMentions: boolean
): void {
  if (SKIPPED.has(node.type) || !node.children) {
    return
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value !== undefined && !child.data) {
      return mentionNodes(child.value, names, everyone)
    }
    const bot = (slackMentions ? slackMention(child) : null) ?? pickedBot(child, source)
    if (bot) {
      return [bot]
    }
    splitMentions(child, names, everyone, source, slackMentions)
    return [child]
  })
}

type SpanProps = ComponentPropsWithoutRef<'span'> & ExtraProps

const MENTION_CHIP = 'rounded-sm bg-accent px-0.5 font-medium text-foreground'

function MentionSpan({
  node: _node,
  'data-orca-bot-chat': chat,
  ...props
}: SpanProps & { 'data-orca-bot-chat'?: string }): React.JSX.Element {
  if (chat) {
    return <BotChatMentionChip {...props} chat={chat} />
  }
  return 'data-orca-mention' in props ? (
    <span {...props} className={MENTION_CHIP} />
  ) : (
    <span {...props} />
  )
}

/** `@Bot › Chat`: the bot's name as the token saved it, the chat's title as it reads now. */
function BotChatMentionChip({
  chat,
  children,
  ...props
}: ComponentPropsWithoutRef<'span'> & { chat: string }): React.JSX.Element {
  const title = useContext(NativeChatBotChatTitleContext)
  const [botId = '', chatId = ''] = chat.split('/')
  // The text is `@<name> › chat <id start>`; the name part stays, the chat part reads by id.
  const fallback = ` › ${botChatIdLabel(chatId)}`
  const text = typeof children === 'string' ? children : ''
  return (
    <span {...props} className={MENTION_CHIP}>
      {title && text.endsWith(fallback) ? (
        <>
          {text.slice(0, -fallback.length)} › {title(botId, chatId)}
        </>
      ) : (
        children
      )}
    </span>
  )
}

/** Chips room members' `@Name`s; with `slackMentions`, a Slack message's drawn mentions too; with
 *  `slackPeople`, Slack's mention tokens. */
export function createNativeChatMentionExtension(
  names: readonly string[],
  everyone = true,
  slackMentions = false,
  slackPeople: SlackPeople | null = null
): Pick<CommentMarkdownExtension, 'remarkPlugins' | 'sanitizeAttributes' | 'components'> {
  return {
    remarkPlugins: [
      () => (tree: MarkdownNode, file: { value: unknown }) => {
        if (slackPeople) {
          showSlackMentionTokens(tree, slackPeople, mentionNode)
        }
        splitMentions(tree, names, everyone, String(file.value), slackMentions)
      }
    ],
    sanitizeAttributes: { span: [MENTION_PROPERTY, BOT_CHAT_PROPERTY] },
    components: { span: MentionSpan }
  }
}
