/** A piece of a Slack message as the chat shows it. `text` is the message's own words, markdown as
 *  typed (Slack's `&lt;` escapes included, which markdown shows as `<`); the rest come from one
 *  `<…>`, their text taken from labels and never trusted. */
export type SlackMarkupSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'link'; url: string; text: string }

/** Slack people a chat knows, name by user id. */
export type SlackPeople = ReadonlyMap<string, string>

// A token holds no `<` or `>`; Slack escapes those inside it.
const TOKEN = /<([^<>]+)>/g
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const BROADCASTS = new Set(['here', 'channel', 'everyone'])
// Characters a label could use to start markdown, HTML or math of its own. Written as entities,
// since chat markdown reads a backslash before a bracket as math.
const MARKDOWN_PUNCTUATION = /[\\`*_[\]<>~$|&]/g

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|amp);/g, (_, name: string) =>
    name === 'lt' ? '<' : name === 'gt' ? '>' : '&'
  )
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_PUNCTUATION, (char) => `&#${char.charCodeAt(0)};`)
}

function prefixed(prefix: string, label: string): string {
  return label.startsWith(prefix) ? label : `${prefix}${label}`
}

/** One `<…>` token as the chat shows it; `people` names a bare `<@U…>`. */
export function slackTokenSegment(
  raw: string,
  body: string,
  people?: SlackPeople | null
): SlackMarkupSegment {
  const bar = body.indexOf('|')
  const target = decodeEntities(bar === -1 ? body : body.slice(0, bar))
  const label = bar === -1 ? '' : oneLine(decodeEntities(body.slice(bar + 1)))
  if (target.startsWith('@')) {
    const name = label || people?.get(target.slice(1))
    return name ? { kind: 'mention', text: prefixed('@', name) } : { kind: 'plain', text: '@user' }
  }
  if (target.startsWith('#')) {
    return label
      ? { kind: 'mention', text: prefixed('#', label) }
      : { kind: 'plain', text: '#channel' }
  }
  if (target.startsWith('!')) {
    const command = target.slice(1).split('^')[0] ?? ''
    if (BROADCASTS.has(command)) {
      return { kind: 'mention', text: `@${command}` }
    }
    if (command === 'subteam') {
      return label
        ? { kind: 'mention', text: prefixed('@', label) }
        : { kind: 'plain', text: '@group' }
    }
    return { kind: 'plain', text: label || raw }
  }
  if (SAFE_LINK.test(target)) {
    return { kind: 'link', url: target, text: label || target }
  }
  // Another scheme opens nothing here; any other `<…>` is the asker's own text, shown as typed.
  return URL_SCHEME.test(target)
    ? { kind: 'plain', text: label || target }
    : { kind: 'plain', text: raw }
}

/** A Slack message split at its `<…>` tokens, in order. */
export function slackMarkupSegments(text: string): SlackMarkupSegment[] {
  const segments: SlackMarkupSegment[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) {
      segments.push({ kind: 'text', text: text.slice(last, match.index) })
    }
    segments.push(slackTokenSegment(match[0], match[1]!))
    last = match.index + match[0].length
  }
  if (last < text.length) {
    segments.push({ kind: 'text', text: text.slice(last) })
  }
  return segments
}

function linkMarkdown(url: string, text: string): string {
  // `&` too, so markdown's own entity pass can't decode the URL a second time.
  const destination = url.replace(/[\s<>\\&]/g, (char) => encodeURIComponent(char))
  return `[${escapeMarkdown(text)}](<${destination}>)`
}

/** A Slack message as plain words for a title or a quoted line: a mention as `@Name`, a channel as
 *  `#name`, a link as its text. The same text back when it holds no token. */
export function slackMarkupPlainText(text: string): string {
  if (!text.includes('<')) {
    return text
  }
  const segments = slackMarkupSegments(text)
  return segments.every((segment) => segment.kind === 'text')
    ? text
    : segments
        .map((segment) => (segment.kind === 'text' ? decodeEntities(segment.text) : segment.text))
        .join('')
}

// A person, channel or ping written exactly as Slack writes one, ids and all.
const SLACK_ID_TOKEN =
  /<((?:@[UW][A-Z0-9]{2,}|#[CG][A-Z0-9]{2,}|!(?:here|channel|everyone)|!subteam\^S[A-Z0-9]+)(?:\|[^<>]*)?)>/g

/** An agent's own words with the Slack mentions in them as plain names, for a notification or a
 *  preview. Only what carries a Slack id is read; any other `<…>` is the agent's text. */
export function slackMentionsPlainText(text: string): string {
  return text.includes('<')
    ? text.replace(SLACK_ID_TOKEN, (raw, body: string) => slackTokenSegment(raw, body).text)
    : text
}

/** A mention in the drawn form: a link to this marker, which the chat draws as a mention. */
export const SLACK_MENTION_HREF = 'orca-mention:'
// The asker's own text never forms the marker: a zero-width joiner breaks it, in the drawn form only.
const TYPED_MARKER = /orca-mention:/gi

/** A Slack message in two forms: `text` reads as Slack shows it (copy, titles, previews), with
 *  links as `text (url)`; `markdown` is what the chat draws, its mentions as `SLACK_MENTION_HREF`
 *  links and every label escaped. Null when the message holds no token. */
export function slackMarkupShownText(text: string): { text: string; markdown: string } | null {
  if (!text.includes('<')) {
    return null
  }
  const segments = slackMarkupSegments(text)
  if (segments.every((segment) => segment.kind === 'text')) {
    return null
  }
  const readable = segments.map((segment) =>
    segment.kind === 'text'
      ? decodeEntities(segment.text)
      : segment.kind === 'link' && segment.text !== segment.url
        ? `${segment.text} (${segment.url})`
        : segment.text
  )
  const markdown = segments.map((segment) =>
    segment.kind === 'text'
      ? segment.text.replace(TYPED_MARKER, 'orca-mention\u200d:')
      : segment.kind === 'link'
        ? linkMarkdown(segment.url, segment.text)
        : segment.kind === 'mention'
          ? `[${escapeMarkdown(segment.text)}](<${SLACK_MENTION_HREF}>)`
          : escapeMarkdown(segment.text)
  )
  return { text: readable.join(''), markdown: markdown.join('') }
}
