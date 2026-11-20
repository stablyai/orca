import type { ConnectorMessageAsker } from '../connector-message-asker'
import { slackTokenSegment, type SlackPeople } from './slack-message-markup'

/** A parsed markdown node, as much of mdast as this reads. */
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

// Mentions, channels, user groups and broadcasts; other `<…>` text stays as written. As the cloud
// reads them, a label never holds `<`, `>`, `|`, a backtick or a backslash once decoded; a token
// whose label does stays as written.
const MENTION_TOKEN =
  /<((?:@[UW][A-Z0-9]+|#[CG][A-Z0-9]+|!subteam\^[A-Z0-9]+|!(?:here|channel|everyone))(?:\|[^<>|`\\]*)?)>/g
const LEADING_TOKEN = new RegExp(`^${MENTION_TOKEN.source}`)
// Raw HTML keeps a label's entities; decoded, these are characters a label never holds.
const ENCODED_BRACKET = /&(?:lt|gt);/
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g
// `<@U…|a@b.com>`: markdown links the email, leaving `<@U…|` and `>` around it.
const OPEN_MENTION = /<@[UW][A-Z0-9]+\|[^<>|`\\]*$/
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

type AskedMessage = { asker?: Pick<ConnectorMessageAsker, 'source' | 'userId' | 'name'> }

/** The Slack people a chat knows, as read from its messages so far. */
export type SlackPeopleScan = {
  first: AskedMessage | undefined
  scanned: number
  people: SlackPeople | null
}

/** The Slack people a chat knows: the askers on its messages, by user id; null when none. Given
 *  the scan of an earlier array of the same chat, reads only messages added since (and the last,
 *  which may still be growing), and keeps the same map while no one new appears. */
export function scanSlackPeople(
  messages: readonly AskedMessage[],
  previous: SlackPeopleScan | null = null
): SlackPeopleScan {
  const grows =
    previous !== null && messages[0] === previous.first && messages.length >= previous.scanned
  let people = grows ? previous.people : null
  for (let i = grows ? Math.max(previous.scanned - 1, 0) : 0; i < messages.length; i++) {
    const asker = messages[i]!.asker
    if (asker?.source === 'slack' && asker.name && people?.get(asker.userId) !== asker.name) {
      people = new Map(people ?? []).set(asker.userId, asker.name)
    }
  }
  return { first: messages[0], scanned: messages.length, people }
}

// The last scan of each chat, keyed by its first message: a chat's arrays keep that object.
const lastScans = new WeakMap<AskedMessage, SlackPeopleScan>()

/** `scanSlackPeople` against this chat's last scan: the same map back while no one new appears. */
export function slackPeopleOf(messages: readonly AskedMessage[]): SlackPeople | null {
  const first = messages[0]
  if (!first) {
    return null
  }
  const scan = scanSlackPeople(messages, lastScans.get(first) ?? null)
  lastScans.set(first, scan)
  return scan.people
}

function tokenNodes(
  value: string,
  people: SlackPeople,
  mention: (text: string) => MarkdownNode
): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let last = 0
  for (const match of value.matchAll(MENTION_TOKEN)) {
    if (match.index > last) {
      nodes.push({ type: 'text', value: value.slice(last, match.index) })
    }
    const segment = ENCODED_BRACKET.test(match[1]!)
      ? null
      : slackTokenSegment(match[0], match[1]!, people)
    nodes.push(
      segment?.kind === 'mention'
        ? mention(segment.text)
        : { type: 'text', value: segment?.text ?? match[0] }
    )
    last = match.index + match[0].length
  }
  if (last < value.length) {
    nodes.push({ type: 'text', value: value.slice(last) })
  }
  return nodes
}

// A line that starts with `<!here>` parses as one raw HTML block, which the chat would drop: it reads
// as text instead, its mentions and `code` spans drawn, anything else as written.
function htmlLineNodes(
  html: string,
  people: SlackPeople,
  mention: (text: string) => MarkdownNode
): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let last = 0
  for (const match of html.matchAll(CODE_SPAN)) {
    nodes.push(...tokenNodes(html.slice(last, match.index), people, mention))
    nodes.push({ type: 'inlineCode', value: match[2]!.replace(/^ (.*) $/s, '$1') })
    last = match.index + match[0].length
  }
  nodes.push(...tokenNodes(html.slice(last), people, mention))
  return nodes
}

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join('') ?? ''
}

// Puts a mention markdown split around an email link back into one text node.
function joinEmailMentions(children: MarkdownNode[]): MarkdownNode[] {
  const joined: MarkdownNode[] = []
  for (let i = 0; i < children.length; i++) {
    const before = joined.at(-1)
    const link = children[i]!
    const after = children[i + 1]
    if (
      link.type === 'link' &&
      link.url?.startsWith('mailto:') &&
      before?.type === 'text' &&
      OPEN_MENTION.test(before.value ?? '') &&
      after?.type === 'text' &&
      after.value?.startsWith('>')
    ) {
      joined[joined.length - 1] = {
        type: 'text',
        value: `${before.value}${plainText(link)}${after.value}`
      }
      i++
      continue
    }
    joined.push(link)
  }
  return joined
}

/** Draws Slack's `<@U…>`-style tokens in parsed chat markdown as names. Runs on the parsed tree, so
 *  code, inline code and math keep them as written. */
export function showSlackMentionTokens(
  node: MarkdownNode,
  people: SlackPeople,
  mention: (text: string) => MarkdownNode
): void {
  if (!node.children) {
    return
  }
  node.children = joinEmailMentions(node.children).flatMap((child) => {
    if (child.type === 'text' && child.value !== undefined) {
      return tokenNodes(child.value, people, mention)
    }
    // `<!here>` and `<!subteam^…>` parse as HTML; at a line's start, the whole line does.
    if (child.type === 'html' && LEADING_TOKEN.test(child.value ?? '')) {
      const nodes = htmlLineNodes(child.value!, people, mention)
      return BLOCK_PARENTS.has(node.type) ? [{ type: 'paragraph', children: nodes }] : nodes
    }
    showSlackMentionTokens(child, people, mention)
    return [child]
  })
}
