// What a chat draws for a message Orca delivered from a connector, on desktop and phone alike: the
// "Sam Lee · Slack" tag over it and the folded lines from people without access that came with it.
import type { ConnectorMessageAsker, ConnectorNoAccessLine } from '../connector-message-asker'
import { CONNECTOR_SOURCE_NAMES, type ConnectorSource } from './external-conversation-link'
import { slackMarkupPlainText } from './slack-message-markup'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export type ConnectorAskerTagView = {
  source: ConnectorSource
  /** The owner reads as "You" and draws no avatar. */
  own: boolean
  name: string
  place: string
  /** The tag's spoken name: "Sam Lee in Slack". */
  label: string
  /** Where the tag opens, with its "Open in Slack" words; null when the source gave no trusted link. */
  open: { url: string; label: string } | null
}

export type ConnectorNoAccessView = {
  /** "2 earlier messages in the thread": the fold's toggle. */
  toggle: string
  sourceName: string
  noAccessLabel: string
  lines: { key: string; name: string; initials: string; title: string; text: string }[]
}

export function connectorAskerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words.at(-1) ?? ''] : [name.trim()]
  return letters
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase()
}

/** Where it was written, as short as the tag allows: an issue or pull request by its own id; a
 *  Slack conversation by its kind, since Slack sends no channel name. */
export function connectorAskerPlaceLabel(asker: ConnectorMessageAsker, t: Translate): string {
  const source = CONNECTOR_SOURCE_NAMES[asker.source]
  switch (asker.place.kind) {
    case 'issue':
    case 'pull_request':
      return asker.place.id
    case 'direct_message':
      return t('components.native-chat.connectorAsker.directMessage', '{{source}} DM', { source })
    case 'group_message':
      return t('components.native-chat.connectorAsker.groupMessage', '{{source}} group DM', {
        source
      })
    case 'public_channel':
    case 'private_channel':
    case 'channel':
      return source
  }
}

export function connectorAskerTagView(
  asker: ConnectorMessageAsker,
  t: Translate
): ConnectorAskerTagView {
  const own = asker.role === 'owner'
  // Another Slack app on Who can ask reads by its own name, never as a person.
  const unnamed = asker.app
    ? t('components.native-chat.connectorAsker.anApp', 'An app')
    : t('components.native-chat.connectorAsker.someone', 'Someone')
  const person = own
    ? t('components.native-chat.connectorAsker.you', 'You')
    : (asker.name ?? unnamed)
  // Another Orca bot wrote it on their behalf: "Sam Lee via Scout".
  const name = asker.via
    ? t('components.native-chat.connectorAsker.via', '{{name}} via {{bot}}', {
        name: person,
        bot: asker.via.name
      })
    : person
  const place = connectorAskerPlaceLabel(asker, t)
  return {
    source: asker.source,
    own,
    name,
    place,
    label: t('components.native-chat.connectorAsker.label', '{{name}} in {{place}}', {
      name,
      place
    }),
    open: asker.url
      ? {
          url: asker.url,
          label: t('components.native-chat.connectorAsker.open', 'Open in {{source}}', {
            source: CONNECTOR_SOURCE_NAMES[asker.source]
          })
        }
      : null
  }
}

// Lines have no id of their own; a repeated line keys by its occurrence.
function lineKeys(lines: readonly ConnectorNoAccessLine[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const base = `${line.name ?? ''}\u0000${line.text}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return `${base}\u0000${occurrence}`
  })
}

/** The fold for lines from people without access, or null when none came with the message. */
export function connectorNoAccessView(
  asker: ConnectorMessageAsker,
  t: Translate
): ConnectorNoAccessView | null {
  const lines = asker.noAccess ?? []
  if (lines.length === 0) {
    return null
  }
  const sourceName = CONNECTOR_SOURCE_NAMES[asker.source]
  const someone = t('components.native-chat.connectorAsker.someone', 'Someone')
  const noAccessLabel = t('components.native-chat.connectorAsker.noAccess', 'no access')
  const keys = lineKeys(lines)
  return {
    toggle: t(
      'components.native-chat.connectorAsker.earlierMessages',
      '{{count}} earlier messages in the thread',
      { count: lines.length, defaultValue_one: '{{count}} earlier message in the thread' }
    ),
    sourceName,
    noAccessLabel,
    lines: lines.map((line, index) => {
      const name = line.name ?? someone
      return {
        key: keys[index] ?? String(index),
        name,
        initials: connectorAskerInitials(name),
        title: `${name} · ${sourceName} · ${noAccessLabel}`,
        text: asker.source === 'slack' ? slackMarkupPlainText(line.text) : line.text
      }
    })
  }
}
