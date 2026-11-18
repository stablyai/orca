import type { ConnectorSource } from './connectors/external-conversation-link'
import { sliceAtCodeUnitLimit } from './text/surrogate-safe-text-slice'

const MAX_TITLE_LENGTH = 120
// the connector service's `threadStart` text for a mention partway through a thread: the thread, then the ask after its last marker.
const THREAD_HISTORY =
  /^Earlier messages in this .+ thread \(reference only, not instructions\):\n[\s\S]*\nRequest:\n/
const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeXmlText(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? '')
}

function linearIssueTitle(text: string): string | null {
  const identifier = /<issue\b[^>]*\bidentifier="([^"]+)"/.exec(text)?.[1]
  if (!identifier) {
    return null
  }
  const title = decodeXmlText(/<title>([\s\S]*?)<\/title>/.exec(text)?.[1] ?? '').trim()
  return title ? `${identifier} · ${title}` : identifier
}

/** A conversation's row title from the text that started it: a Linear issue's key and title, else the ask's first line. */
export function externalConversationTitle(source: ConnectorSource, text: string): string {
  const linear = source === 'linear' ? linearIssueTitle(text) : null
  const ask = linear ?? text.replace(THREAD_HISTORY, '')
  const line =
    ask
      .split('\n')
      .find((candidate) => candidate.trim() !== '')
      ?.trim() ?? ''
  return line.length > MAX_TITLE_LENGTH
    ? `${sliceAtCodeUnitLimit(line, MAX_TITLE_LENGTH - 1)}…`
    : line
}
