import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'

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

/** New rows whose reply text is known to extend a previous row's, with that row's text. */
const knownGrowth = new WeakMap<AgentJournalRenderItem, string>()

function replyText(item: AgentJournalRenderItem): string | null {
  const { body } = item
  return body.kind === 'message' && body.blocks.length === 1 && body.blocks[0]?.type === 'text'
    ? body.blocks[0].text
    : null
}

/** Compares a new row with the one it follows once, where it is built, so every reader's check
 *  that it extends what that reader holds is a reference compare instead of a scan of the reply. */
export function noteReplyTextGrowth(
  item: AgentJournalRenderItem,
  previous: AgentJournalRenderItem | undefined
): void {
  const base = previous ? replyText(previous) : null
  const text = replyText(item)
  if (base !== null && text !== null && text.length > base.length && text.startsWith(base)) {
    knownGrowth.set(item, base)
  }
}

/** Whether `item`'s `text` starts with `base`. */
export function textExtends(item: AgentJournalRenderItem, text: string, base: string): boolean {
  return knownGrowth.get(item) === base || text.startsWith(base)
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

function endsTurn(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'turn' && item.body.state !== 'running'
}

function runsTurn(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'turn' && item.body.state === 'running'
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
): ((event: AgentSessionSubscribeEvent) => AgentSessionSubscribeEvent | null) & {
  /** Null once its turn ended and the base was let go of: no live row awaits it. */
  holds: (itemId: string) => boolean | null
  /** Lets go of every base, or only those of rows the given turns own. */
  release: (turnItemIds?: ReadonlySet<string>) => void
} {
  // A released base keeps its place (null), so the sender evicts exactly as its readers do.
  const bases = new Map<string, string | null>()
  const turnOf = new Map<string, string>()
  let epoch: string | null = null
  const note = (item: AgentJournalRenderItem): void => {
    bases.delete(item.itemId)
    turnOf.delete(item.itemId)
    const text = growingText(item, rules)
    if (text === null || isFinished(item)) {
      return
    }
    bases.set(item.itemId, text)
    if (item.turnScope?.kind === 'turn') {
      turnOf.set(item.itemId, item.turnScope.turnItemId)
    }
    const limit = rules.toolOutputAppend === 1 ? MAX_TEXT_APPEND_BASES : MAX_REPLY_APPEND_BASES
    const oldest = bases.size > limit ? bases.keys().next().value : undefined
    if (oldest !== undefined) {
      bases.delete(oldest)
      turnOf.delete(oldest)
    }
  }
  const stream = (event: AgentSessionSubscribeEvent): AgentSessionSubscribeEvent | null => {
    if (event.type === 'end') {
      return event
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
      bases.clear()
      turnOf.clear()
      epoch = event.page.epoch
      event.page.items.forEach(note)
      return event
    }
    // A new journal epoch renumbers rows, so nothing from the old one is a base.
    if (event.batch.cursor.epoch !== epoch) {
      bases.clear()
      turnOf.clear()
      epoch = event.batch.cursor.epoch
    }
    for (const itemId of event.batch.removedItemIds) {
      bases.delete(itemId)
      turnOf.delete(itemId)
    }
    let changed = false
    const items: AgentJournalRenderItem[] = []
    for (const item of event.batch.items) {
      const mapped = mapItem(bases.get(item.itemId) ?? undefined, item)
      if (mapped === null) {
        return null
      }
      changed ||= mapped !== item
      items.push(mapped)
      note('textAppend' in mapped ? item : mapped)
    }
    return changed ? { ...event, batch: { ...event.batch, items } } : event
  }
  return Object.assign(stream, {
    holds: (itemId: string) => {
      const base = bases.get(itemId)
      return base === null ? null : base !== undefined
    },
    release: (turnItemIds?: ReadonlySet<string>) => {
      for (const itemId of bases.keys()) {
        const turn = turnOf.get(itemId)
        if (!turnItemIds || (turn !== undefined && turnItemIds.has(turn))) {
          bases.set(itemId, null)
          turnOf.delete(itemId)
        }
      }
    }
  })
}

/** Host side, wrapping a stream's emit after every other projection: text that extends what this
 *  stream last sent for its item goes out as only the new text. */
export function sendingTextAppends<R>(
  emit: (event: AgentSessionSubscribeEvent) => R,
  rules: TextAppendRules
): ((event: AgentSessionSubscribeEvent) => R) & {
  holdsBase: (itemId: string) => boolean | null
} {
  const send = textAppendStream(rules, (base, item) => {
    const text = growingText(item, rules)
    if (base === undefined || text === null || !textExtends(item, text, base)) {
      return item
    }
    return {
      ...withText(item, ''),
      textAppend: { from: base.length, text: text.slice(base.length) }
    } satisfies AgentSessionTextAppendItem
  })
  return Object.assign(
    (event: AgentSessionSubscribeEvent) => {
      const sent = emit(send(event) ?? event)
      // A finished turn's replies no longer grow, and a final reply carries no completion mark, so
      // the sender lets go of that turn's bases then; a later revision of an old turn (a context
      // report) leaves a newer reply's alone. Only the sender may: a row without a base goes whole,
      // which any reader takes, while a reader missing a base its sender holds could not.
      // A replacement page with no turn running, on it or off it, holds only finished replies.
      if (event.type === 'batch') {
        const ended = event.batch.items.filter(endsTurn).map((item) => item.itemId)
        if (ended.length > 0) {
          send.release(new Set(ended))
        }
      } else if (
        (event.type === 'snapshot' || event.type === 'reset') &&
        event.page.latestTurn?.turn.state !== 'running' &&
        !event.page.items.some(runsTurn)
      ) {
        send.release()
      }
      return sent
    },
    { holdsBase: send.holds }
  )
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
