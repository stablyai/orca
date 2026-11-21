// Where a bot's new memories came from, as Orca saw it: the messages that started its turns, never
// the bot's say-so. A label is what MEMORY.md and Settings show after "from"; null is the owner.
import type { AgentJournalItemBody } from '../agent-session/journal/agent-session-journal-types'
import type { ConnectorMessageAsker } from '../connector-message-asker'
import { CONNECTOR_SOURCE_NAMES } from '../connectors/external-conversation-link'

const MAX_LABEL_LENGTH = 200
const MAX_URL_LENGTH = 300
/** A label shows 200 characters and each place, and each person of a place, adds at least one
 *  after cleaning: a 201st place or a place's 201st person starts past them. */
export const BOT_MEMORY_SOURCES_SHOWN = MAX_LABEL_LENGTH

/** A chat's outside sources, small enough to cross from the journal worker whatever the chat holds:
 *  places in first-seen order with their people, and up to two links (one is shown, two none). */
export type BotMemorySources = {
  places: { place: string; people: string[] }[]
  urls: string[]
}

/** One line, nothing that reads as Orca's own marks. */
export function cleanBotMemoryLabel(text: string): string {
  return text.replace(SEPARATORS, ' ').trim().slice(0, MAX_LABEL_LENGTH)
}

export function withBotMemoryLink(label: string, url: string | undefined): string {
  return url && url.length <= MAX_URL_LENGTH && /^https:\/\/[^\s<>]+$/.test(url)
    ? `${label} <${url}>`
    : label
}

type OutsideSource = { place: string; person?: string; url?: string }

const SEPARATORS = /[\u00b7<>\s]+/g
const VISIBLE = /[^\u00b7<>\s]/

/** The text up to where it holds more than a label shows once cleaned: any rest is never seen. A
 *  long one has its separator runs collapsed first, as cleaning would, so its size is bounded too. */
function shown(raw: string): string {
  const text = raw.length > MAX_LABEL_LENGTH * 4 ? raw.replace(SEPARATORS, ' ') : raw
  let kept = 0
  for (let index = 0; index < text.length; index += 1) {
    if (VISIBLE.test(text[index]!) && ++kept > MAX_LABEL_LENGTH) {
      return text.slice(0, index + 1)
    }
  }
  return text
}

/** A link longer than a label carries is never shown; one character over still tells it apart. */
const shownUrl = (url: string): string => url.slice(0, MAX_URL_LENGTH + 1)

function askerSource(asker: ConnectorMessageAsker): OutsideSource {
  const app = CONNECTOR_SOURCE_NAMES[asker.source]
  // A Slack channel id reads as noise; the link names the place.
  const place = asker.source === 'slack' ? app : `${app} ${asker.place.id}`
  return { place, person: asker.name ?? asker.userId, ...(asker.url ? { url: asker.url } : {}) }
}

function outsideSource(body: AgentJournalItemBody): OutsideSource | null {
  const source = rawOutsideSource(body)
  return source
    ? {
        place: shown(source.place),
        ...(source.person ? { person: shown(source.person) } : {}),
        ...(source.url ? { url: shownUrl(source.url) } : {})
      }
    : null
}

function rawOutsideSource(body: AgentJournalItemBody): OutsideSource | null {
  if (body.kind !== 'message' || body.role !== 'user') {
    return null
  }
  if (body.memorySource) {
    const linked = /^(.*?)\s*<(https:\/\/[^\s<>]+)>$/.exec(body.memorySource)
    return linked ? { place: linked[1], url: linked[2] } : { place: body.memorySource }
  }
  if (body.origin === 'connector') {
    return body.asker ? askerSource(body.asker) : { place: 'a connector message' }
  }
  return body.from ? { place: 'another agent' } : null
}

/** Gathers sources from rows or other gatherings, in order, keeping only what a label can show. */
export function gatherBotMemorySources() {
  const places = new Map<string, Set<string>>()
  const urls = new Set<string>()
  const link = (url: string | undefined): void => {
    if (url && urls.size < 2) {
      urls.add(url)
    }
  }
  const add = (place: string, person?: string): void => {
    let people = places.get(place)
    if (!people) {
      if (places.size >= BOT_MEMORY_SOURCES_SHOWN) {
        return
      }
      people = new Set()
      places.set(place, people)
    }
    if (person && people.size < BOT_MEMORY_SOURCES_SHOWN) {
      people.add(person)
    }
  }
  return {
    row: (body: AgentJournalItemBody): void => {
      const source = outsideSource(body)
      if (source) {
        add(source.place, source.person)
        link(source.url)
      }
    },
    sources: ({ places: from, urls: links }: BotMemorySources): void => {
      for (const { place, people } of from) {
        add(place)
        people.forEach((person) => add(place, person))
      }
      links.forEach(link)
    },
    read: (): BotMemorySources => ({
      places: [...places].map(([place, people]) => ({ place, people: [...people] })),
      urls: [...urls]
    })
  }
}

/** The sources of these rows. */
export function botMemorySourcesOf(bodies: Iterable<AgentJournalItemBody>): BotMemorySources {
  const gathered = gatherBotMemorySources()
  for (const body of bodies) {
    gathered.row(body)
  }
  return gathered.read()
}

/**
 * The label for facts written in a window with these sources: null when only the owner spoke, else
 * every outside source among them ("Slack, Dana + Bob"). Queued turns can end together, and nothing
 * tells reliably which wrote what, so an outside turn's label covers the whole window.
 */
export function botMemorySourceLabel(all: readonly BotMemorySources[]): string | null {
  const gathered = gatherBotMemorySources()
  all.forEach(gathered.sources)
  const { places, urls } = gathered.read()
  if (places.length === 0) {
    return null
  }
  const label = places
    .map(({ place, people }) => (people.length > 0 ? `${place}, ${people.join(' + ')}` : place))
    .join('; ')
  return withBotMemoryLink(cleanBotMemoryLabel(label), urls.length === 1 ? urls[0] : undefined)
}
