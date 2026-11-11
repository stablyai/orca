import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'

/** What a stream asks for on `agentSession.subscribe`, sent only when the host advertises it. Both
 *  ends of the stream follow the rules it names, so they hold the same bases. */
export type AgentSessionTextAppendCapabilities = { textAppend: 1; toolOutputAppend?: 1 }
type TextAppendRules = Pick<AgentSessionTextAppendCapabilities, 'toolOutputAppend'>

/** What to ask a host for, from whether it advertises each append runtime capability. */
export function agentSessionTextAppendRequest(advertises: {
  textAppend: boolean
  toolOutputAppend: boolean
}): AgentSessionTextAppendCapabilities | null {
  if (!advertises.textAppend) {
    return null
  }
  return advertises.toolOutputAppend ? { textAppend: 1, toolOutputAppend: 1 } : { textAppend: 1 }
}

/** A growing reply, or with `toolOutputAppend` a tool call's output head, sent as only its new text:
 *  that text is empty on the wire, and the reader restores it as the text it holds for the item
 *  (`from` long) followed by `text`. */
export type AgentSessionTextAppendItem = AgentJournalRenderItem & {
  textAppend: { from: number; text: string }
}

// Bases are only unfinished replies and running tool calls, so a few cover every stream a turn grows at once.
// Text-only readers already shipped evict past 8, so a host must never hold more for them.
const MAX_REPLY_APPEND_BASES = 8
const MAX_TEXT_APPEND_BASES = 16

function growingText(item: AgentJournalRenderItem, rules: TextAppendRules): string | null {
  const { body } = item
  if (item.shortened) {
    return null
  }
  if (body.kind === 'tool-call') {
    return rules.toolOutputAppend === 1 && body.output ? body.output.head : null
  }
  if (
    body.kind !== 'message' ||
    (body.role !== 'assistant' && body.role !== 'reasoning') ||
    body.blocks.length !== 1 ||
    body.blocks[0]?.type !== 'text'
  ) {
    return null
  }
  return body.blocks[0].text
}

function isFinished(item: AgentJournalRenderItem): boolean {
  const { body } = item
  return body.kind === 'tool-call'
    ? body.state !== 'running'
    : body.kind === 'message' && body.completedAt !== undefined
}

function isTextAppendItem(item: AgentJournalRenderItem): item is AgentSessionTextAppendItem {
  if (!('textAppend' in item)) {
    return false
  }
  const append: unknown = item.textAppend
  return (
    typeof append === 'object' &&
    append !== null &&
    'from' in append &&
    typeof append.from === 'number' &&
    'text' in append &&
    typeof append.text === 'string'
  )
}

function withText(item: AgentJournalRenderItem, text: string): AgentJournalRenderItem {
  const { body } = item
  if (body.kind === 'tool-call' && body.output) {
    return { ...item, body: { ...body, output: { ...body.output, head: text } } }
  }
  if (body.kind !== 'message' || body.blocks[0]?.type !== 'text') {
    return item
  }
  return { ...item, body: { ...body, blocks: [{ ...body.blocks[0], text }] } }
}

/** One stream's sender or reader. Both walk every frame of the stream in order with the same
 *  rules, so they hold the same base text for each item without exchanging anything else. */
function textAppendStream(
  rules: TextAppendRules,
  mapItem: (base: string | undefined, item: AgentJournalRenderItem) => AgentJournalRenderItem | null
): (event: AgentSessionSubscribeEvent) => AgentSessionSubscribeEvent | null {
  const bases = new Map<string, string>()
  let epoch: string | null = null
  const note = (item: AgentJournalRenderItem): void => {
    bases.delete(item.itemId)
    const text = growingText(item, rules)
    if (text === null || isFinished(item)) {
      return
    }
    bases.set(item.itemId, text)
    const limit = rules.toolOutputAppend === 1 ? MAX_TEXT_APPEND_BASES : MAX_REPLY_APPEND_BASES
    const oldest = bases.size > limit ? bases.keys().next().value : undefined
    if (oldest !== undefined) {
      bases.delete(oldest)
    }
  }
  return (event) => {
    if (event.type === 'end') {
      return event
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
      bases.clear()
      epoch = event.page.epoch
      event.page.items.forEach(note)
      return event
    }
    // A new journal epoch renumbers rows, so nothing from the old one is a base.
    if (event.batch.cursor.epoch !== epoch) {
      bases.clear()
      epoch = event.batch.cursor.epoch
    }
    for (const itemId of event.batch.removedItemIds) {
      bases.delete(itemId)
    }
    let changed = false
    const items: AgentJournalRenderItem[] = []
    for (const item of event.batch.items) {
      const mapped = mapItem(bases.get(item.itemId), item)
      if (mapped === null) {
        return null
      }
      changed ||= mapped !== item
      items.push(mapped)
      note('textAppend' in mapped ? item : mapped)
    }
    return changed ? { ...event, batch: { ...event.batch, items } } : event
  }
}

/** Host side, wrapping a stream's emit after every other projection: text that extends what this
 *  stream last sent for its item goes out as only the new text. */
export function sendingTextAppends<R>(
  emit: (event: AgentSessionSubscribeEvent) => R,
  rules: TextAppendRules
): (event: AgentSessionSubscribeEvent) => R {
  const send = textAppendStream(rules, (base, item) => {
    const text = growingText(item, rules)
    if (base === undefined || text === null || !text.startsWith(base)) {
      return item
    }
    return {
      ...withText(item, ''),
      textAppend: { from: base.length, text: text.slice(base.length) }
    } satisfies AgentSessionTextAppendItem
  })
  return (event) => emit(send(event) ?? event)
}

/** Client side: whole items back from appends; null when an append does not start where this
 *  reader's text for the item ends, and only a new stream (which sends whole items) can recover. */
export function createAgentSessionTextAppendReader(
  rules: TextAppendRules
): (event: AgentSessionSubscribeEvent) => AgentSessionSubscribeEvent | null {
  return textAppendStream(rules, (base, item) => {
    if (!('textAppend' in item)) {
      return item
    }
    if (!isTextAppendItem(item)) {
      return null
    }
    const { textAppend, ...rest } = item
    if (base === undefined || base.length !== textAppend.from || growingText(rest, rules) !== '') {
      return null
    }
    return withText(rest, base + textAppend.text)
  })
}
