import type { ConnectorMessageAsker } from '../connector-message-asker'
import { slackTokenSegment, type SlackPeople } from './slack-message-markup'

/** A parsed markdown node, as much of mdast as this reads. */
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

// Mentions, channels, user groups and broadcasts; other `<…>` text stays as written.
const MENTION_TOKEN =
  /<((?:@[UW][A-Z0-9]+|#C[A-Z0-9]+|!subteam\^[A-Z0-9]+|!(?:here|channel|everyone))(?:\|[^<>]*)?)>/g
// `<@U…|a@b.com>`: markdown links the email, leaving `<@U…|` and `>` around it.
const OPEN_MENTION = /<@[UW][A-Z0-9]+\|[^<>]*$/
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** The Slack people a chat knows: the askers on its messages, by user id. Null when none. */
export function slackPeopleOf(
  messages: readonly { asker?: Pick<ConnectorMessageAsker, 'source' | 'userId' | 'name'> }[]
): SlackPeople | null {
  const people = new Map<string, string>()
  for (const { asker } of messages) {
    if (asker?.source === 'slack' && asker.name) {
      people.set(asker.userId, asker.name)
    }
  }
  return people.size > 0 ? people : null
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
    const segment = slackTokenSegment(match[0], match[1]!, people)
    nodes.push(
      segment.kind === 'mention' ? mention(segment.text) : { type: 'text', value: segment.text }
    )
    last = match.index + match[0].length
  }
  if (last < value.length) {
    nodes.push({ type: 'text', value: value.slice(last) })
  }
  return nodes
}

function onlyBroadcastTokens(html: string): boolean {
  return html.startsWith('<!') && !html.replace(MENTION_TOKEN, '').includes('<')
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
    if (child.type === 'html' && onlyBroadcastTokens(child.value ?? '')) {
      const nodes = tokenNodes(child.value!, people, mention)
      return BLOCK_PARENTS.has(node.type) ? [{ type: 'paragraph', children: nodes }] : nodes
    }
    showSlackMentionTokens(child, people, mention)
    return [child]
  })
}
