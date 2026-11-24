// What an item note says: quiet lines with item names as chips ("Added and moved … to In progress",
// "You moved … to …"), and the owner's comments as their own message with the item's chip. Each line
// is one translated sentence split around its chips. The desktop and the phone draw the same lines.
import type {
  BotItemNoteChat,
  BotItemNoteEntry,
  BotItemNoteItem,
  BotItemNoteView
} from './bot-item-note'
import { botItemStatusName } from './bot-item-status-name'
import { botAct, type BotAct } from './bot-item-note-acts'
import type { BotItemCommentImage } from './bot-items'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** The chat a line names, drawn as a chip that opens it (Home Chat by its live session); `after`:
 *  the words between it and the items. */
export type BotItemNoteLineChat = { chatId: string; name: string; after: string; home?: true }

/** The one link a line names, a worker's by `dispatchId`; `after`: the words before the items. */
export type BotItemNoteLineLink = { name: string; after: string; dispatchId?: string }

export type BotItemNoteLine =
  | {
      kind: 'line'
      lead: string
      chat?: BotItemNoteLineChat
      link?: BotItemNoteLineLink
      items: BotItemNoteItem[]
      tail?: string
      detail?: string
    }
  | { kind: 'comment'; item: BotItemNoteItem; text: string; images?: BotItemCommentImage[] }

const ITEM_TEXT_MAX = 240

function short(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > ITEM_TEXT_MAX ? `${line.slice(0, ITEM_TEXT_MAX - 1)}…` : line
}

function byItem(entries: readonly BotItemNoteEntry[]): BotItemNoteEntry[][] {
  const items = new Map<string, BotItemNoteEntry[]>()
  for (const entry of entries) {
    items.set(entry.uid, [...(items.get(entry.uid) ?? []), entry])
  }
  return [...items.values()]
}

function chipOf(entries: readonly BotItemNoteEntry[]): BotItemNoteItem {
  const last = entries.at(-1)!
  return { uid: last.uid, number: last.number, title: last.title, status: last.status }
}

/** Where a sentence's chips go: the translated sentence splits there into lead and tail. */
const ITEMS = '\uE000'
/** Where the acting chat's chip goes, before the items' chips. */
const CHAT = '\uE001'
/** Where the one link's name goes, just before the items. */
const LINK = '\uE002'

type Around = Pick<BotItemNoteLine & { kind: 'line' }, 'lead' | 'chat' | 'link' | 'tail'>

/** A translated whole sentence ("Added and moved {{items}} to {{status}}", `items: ITEMS`) as the
 *  words around its chips; either side may be empty, so a translation puts the chips where its
 *  grammar wants them. A chat chip a translation puts after the items reads as its plain name. */
function around(
  sentence: string,
  chat?: Omit<BotItemNoteLineChat, 'after'>,
  named?: { name: string | null; dispatchId?: string }
): Around {
  const linkName = named?.name ?? undefined
  const [head = '', rest = ''] = sentence.split(ITEMS)
  // A translation that names the link after the items, or before the chat, reads it as words.
  const tail = (chat ? rest.replace(CHAT, chat.name) : rest).replace(LINK, linkName ?? '')
  const [lead = '', after] = head.split(CHAT)
  const byChat = chat && after !== undefined
  const [before = '', afterLink] = (byChat ? after : lead).split(LINK)
  return {
    lead: (byChat ? lead.replace(LINK, linkName ?? '') : before).trim(),
    ...(byChat ? { chat: { ...chat, after: before.trim() } } : {}),
    ...(linkName !== undefined && afterLink !== undefined
      ? {
          link: {
            name: linkName,
            after: afterLink.trim(),
            ...(named?.dispatchId ? { dispatchId: named.dispatchId } : {})
          }
        }
      : {}),
    ...(tail.trim() ? { tail: tail.trim() } : {})
  }
}

/** The line's words: one whole-sentence key per result. */
function botSentence({ added, ...act }: { added: boolean } & BotAct, t: Translate): Around {
  switch (act.act) {
    case 'move': {
      const status = botItemStatusName(act.to, t)
      return around(
        added
          ? t('bots.items.chat.addedAndMoved', 'Added and moved {{items}} to {{status}}', {
              items: ITEMS,
              status
            })
          : t('bots.items.chat.moved', 'Moved {{items}} to {{status}}', { items: ITEMS, status })
      )
    }
    case 'ask':
      return around(
        added
          ? t('bots.items.chat.addedAndAsked', 'Added and asked you about {{items}}', {
              items: ITEMS
            })
          : t('bots.items.chat.askedYou', 'Asked you about {{items}}', { items: ITEMS })
      )
    case 'done':
      return around(
        added
          ? t('bots.items.chat.addedAndDone', 'Added and marked {{items}} done', { items: ITEMS })
          : t('bots.items.chat.marked', 'Marked {{items}} done', { items: ITEMS })
      )
    case 'canceled':
      return around(
        added
          ? t('bots.items.chat.addedAndCanceled', 'Added and canceled {{items}}', { items: ITEMS })
          : t('bots.items.chat.canceled', 'Canceled {{items}}', { items: ITEMS })
      )
    case 'none':
      return around(t('bots.items.chat.added', 'Added {{items}}', { items: ITEMS }))
    case 'comment':
      return around(t('bots.items.chat.commented', 'Commented on {{items}}', { items: ITEMS }))
    case 'update':
      return around(t('bots.items.chat.updated', 'Updated {{items}}', { items: ITEMS }))
    case 'link':
      return around(
        act.link.count > 1
          ? t('bots.items.chat.linkedMany', 'Linked {{count}} links to {{items}}', {
              items: ITEMS,
              count: act.link.count
            })
          : t('bots.items.chat.linked', 'Linked {{link}} to {{items}}', {
              items: ITEMS,
              link: act.link.name === null ? t('bots.items.chat.aWorker', 'a worker') : LINK
            }),
        undefined,
        act.link
      )
  }
}

/** Another chat's write, the sentence naming it: as a chip (`CHAT`) or, for a chat gone or unnamed
 *  in an older note, as words. Its writes never add the item, which the asking chat's mail does. */
function chatSentence(act: BotAct, chat: string, t: Translate): string {
  const v = { items: ITEMS, chat }
  switch (act.act) {
    case 'move':
      return t('bots.items.chat.byChat.moved', '{{chat}} moved {{items}} to {{status}}', {
        ...v,
        status: botItemStatusName(act.to, t)
      })
    case 'ask':
      return t('bots.items.chat.byChat.askedYou', '{{chat}} asked you about {{items}}', v)
    case 'done':
      return t('bots.items.chat.byChat.marked', '{{chat}} marked {{items}} done', v)
    case 'canceled':
      return t('bots.items.chat.byChat.canceled', '{{chat}} canceled {{items}}', v)
    case 'none':
      return t('bots.items.chat.byChat.added', '{{chat}} added {{items}}', v)
    case 'comment':
      return t('bots.items.chat.byChat.commented', '{{chat}} commented on {{items}}', v)
    case 'update':
      return t('bots.items.chat.byChat.updated', '{{chat}} updated {{items}}', v)
    case 'link':
      return act.link.count > 1
        ? t('bots.items.chat.byChat.linkedMany', '{{chat}} linked {{count}} links to {{items}}', {
            ...v,
            count: act.link.count
          })
        : t('bots.items.chat.byChat.linked', '{{chat}} linked {{link}} to {{items}}', {
            ...v,
            link: act.link.name === null ? t('bots.items.chat.aWorker', 'a worker') : LINK
          })
  }
}

/** How a line names another chat: Home Chat, its title, or "Another chat". */
function chatName(chat: BotItemNoteChat | 'other-agent' | null, t: Translate): string {
  if (chat === 'other-agent') {
    return t('bots.items.chat.anotherAgent', 'Another agent')
  }
  return chat?.home
    ? t('bots.items.homeChat', 'Home Chat')
    : chat?.title || t('bots.items.chat.anotherChat', 'Another chat')
}

/** One act and destination, whatever language draws it. */
function actKey({ added, ...act }: { added: boolean } & BotAct): string {
  const to = act.act === 'move' ? act.to : act.act === 'link' ? JSON.stringify(act.link) : ''
  return `${added}|${act.act}|${to}`
}

/** The bot's own changes (or, with `by`, another of its chats'): each item once, at its final state;
 *  items that ended the same way share a line, in the order they first appear. */
function botLines(
  entries: readonly BotItemNoteEntry[],
  t: Translate,
  by?: BotItemNoteChat | 'other-agent' | null
): BotItemNoteLine[] {
  const sentence = (act: { added: boolean } & BotAct): Around => {
    if (by === undefined) {
      return botSentence(act, t)
    }
    const name = chatName(by, t)
    const link = act.act === 'link' ? act.link : undefined
    return by && by !== 'other-agent'
      ? around(
          chatSentence(act, CHAT, t),
          { chatId: by.chatId, name, ...(by.home ? { home: true as const } : {}) },
          link
        )
      : around(chatSentence(act, name, t), undefined, link)
  }
  const lines = new Map<string, BotItemNoteLine & { kind: 'line' }>()
  for (const itemEntries of byItem(entries)) {
    const act = botAct(itemEntries)
    const key = actKey(act)
    const same = lines.get(key)
    if (same) {
      same.items.push(chipOf(itemEntries))
    } else {
      lines.set(key, { kind: 'line', ...sentence(act), items: [chipOf(itemEntries)] })
    }
  }
  return [...lines.values()]
}

/** The owner's changes from the Items tab: comments as their message, moves as one line. */
function ownerLines(entries: readonly BotItemNoteEntry[], t: Translate): BotItemNoteLine[] {
  const lines: BotItemNoteLine[] = []
  const moves = entries.flatMap((entry) => (entry.event === 'status' ? [entry] : []))
  const to = moves[0]?.to
  if (to !== undefined && moves.length > 1 && moves.every((entry) => entry.to === to)) {
    const count = moves.length
    lines.push({
      kind: 'line',
      ...(to === 'done'
        ? around(
            t('bots.items.chat.youMarkedManyDone', 'You marked {{count}} items done: {{items}}', {
              items: ITEMS,
              count
            })
          )
        : to === 'canceled'
          ? around(
              t('bots.items.chat.youCanceledMany', 'You canceled {{count}} items: {{items}}', {
                items: ITEMS,
                count
              })
            )
          : around(
              t(
                'bots.items.chat.youMovedMany',
                'You moved {{count}} items to {{status}}: {{items}}',
                { items: ITEMS, count, status: botItemStatusName(to, t) }
              )
            )),
      items: moves.map((entry) => chipOf([entry])),
      ...(moves[0]!.note ? { detail: short(moves[0]!.note) } : {})
    })
  } else {
    for (const entry of moves) {
      const closed = entry.to === 'done' || entry.to === 'canceled'
      const note = closed && entry.note ? { detail: short(entry.note) } : {}
      lines.push({
        kind: 'line',
        ...(entry.to === 'done'
          ? around(t('bots.items.chat.youMarked', 'You marked {{items}} done', { items: ITEMS }))
          : entry.to === 'canceled'
            ? around(t('bots.items.chat.youCanceled', 'You canceled {{items}}', { items: ITEMS }))
            : around(
                t('bots.items.chat.youMoved', 'You moved {{items}} to {{status}}', {
                  items: ITEMS,
                  status: botItemStatusName(entry.to, t)
                })
              )),
        items: [chipOf([entry])],
        ...note
      })
    }
  }
  for (const entry of entries) {
    if (entry.event === 'commented') {
      lines.push({
        kind: 'comment',
        item: chipOf([entry]),
        text: entry.text,
        ...(entry.images ? { images: entry.images } : {})
      })
    }
  }
  return lines
}

export function botItemNoteLines(note: BotItemNoteView, t: Translate): BotItemNoteLine[] {
  const { by } = note
  if (by === 'owner') {
    return ownerLines(note.entries, t)
  }
  return by === 'bot'
    ? botLines(note.entries, t)
    : botLines(note.entries, t, typeof by === 'object' || by === 'other-agent' ? by : null)
}

/** A folded run of the owner's quick changes to one item: first → last status and how many. */
export function botItemNoteRunLine(
  run: NonNullable<BotItemNoteView['run']>,
  t: Translate
): BotItemNoteLine & { kind: 'line' } {
  const first = run[0]!.entries[0]!
  const last = run.at(-1)!.entries[0]!
  const from = first.event === 'status' ? first.from : first.status
  return {
    kind: 'line',
    ...around(t('bots.items.chat.youChanged', 'You changed {{items}}', { items: ITEMS })),
    items: [chipOf([last])],
    detail: t('bots.items.chat.changes', '{{from}} → {{to}} · {{count}} changes', {
      from: botItemStatusName(from, t),
      to: botItemStatusName(last.status, t),
      count: run.length
    })
  }
}

/** A note drawn only as quiet lines, which sit close to each other; an owner's comment is a message. */
export function botItemNoteIsQuiet(note: BotItemNoteView): boolean {
  return (
    note.run !== undefined ||
    note.by !== 'owner' ||
    !note.entries.some((entry) => entry.event === 'commented')
  )
}
