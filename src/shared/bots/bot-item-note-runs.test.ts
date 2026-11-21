import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import type { BotItemNoteEntry } from './bot-item-note'
import { botItemNoteJoins, foldBotItemNotes } from './bot-item-note-runs'
import { botItemNoteLines, botItemNoteRunLine } from './bot-item-note-lines'

function move(id: string, uid: string, to: 'working' | 'done' | 'needs_you'): NativeChatMessage {
  const entry: BotItemNoteEntry = {
    uid,
    number: 1,
    title: 'Share dialog',
    status: to,
    event: 'status',
    from: 'planned',
    to
  }
  return {
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [],
    botItemNote: { noteId: id, by: 'owner', entries: [entry] }
  }
}

function itemMail(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Your owner moved it' }],
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'm',
        dispatchId: null,
        messages: [{ messageId: `msg_item_${id}`, runId: 'r', from: 'orca:items' }]
      }
    }
  }
}

function toolCall(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'tool-call', callId: `call-${id}`, name: 'Bash', input: {} }]
  }
}

function said(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Paused the fix worker.' }]
  }
}

describe('foldBotItemNotes', () => {
  it('folds the owner’s quick moves of one item into the first, past hidden item mail', () => {
    const folded = foldBotItemNotes([
      move('a', 'item-1', 'working'),
      itemMail('a'),
      move('b', 'item-1', 'done'),
      itemMail('b'),
      move('c', 'item-1', 'needs_you')
    ])

    expect(folded).toHaveLength(5)
    expect(folded[0]!.botItemNote?.run?.map((note) => note.noteId)).toEqual(['a', 'b', 'c'])
    expect(folded.slice(1).every((message) => message.botItemNote === undefined)).toBe(true)
    expect(folded[1]!.blocks).toEqual([])
  })

  it('keeps moves apart when something shown sits between them or the item differs', () => {
    const folded = foldBotItemNotes([
      move('a', 'item-1', 'working'),
      said('reply'),
      move('b', 'item-1', 'done'),
      move('c', 'item-2', 'done')
    ])

    expect(folded.map((message) => message.botItemNote?.run)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })
})

type Status = BotItemNoteEntry['status']
const titles: Record<string, string> = {
  win: 'Windows path casing audit',
  share: 'Share links',
  rel: 'Release notes',
  tok: 'Token refresh fix',
  flaky: 'Flaky test sweep',
  dlg: 'Share dialog',
  onb: 'Onboarding copy',
  login: 'Login flaky test',
  exp: 'Export timeout',
  long: 'Relay director reassigns hosts'
}
const item = (uid: string, status: Status) => ({
  uid,
  number: 1,
  title: titles[uid] ?? uid,
  status
})
const made = (uid: string): BotItemNoteEntry => ({ ...item(uid, 'planned'), event: 'made' })
const moved = (uid: string, from: Status, to: Status): BotItemNoteEntry => ({
  ...item(uid, to),
  event: 'status',
  from,
  to
})
const commented = (uid: string, at: Status): BotItemNoteEntry => ({
  ...item(uid, at),
  event: 'commented',
  text: 'Which way?'
})
const linked = (uid: string, at: Status, ref: string): BotItemNoteEntry => ({
  ...item(uid, at),
  event: 'linked',
  refs: [ref],
  names: { [ref]: ref === 'pr:acme/app#812' ? '#812' : 'Codex worker' }
})

type Row = { message: NativeChatMessage; turn?: string }
let rowAt = 0
function note(
  by: 'bot' | 'owner' | 'other-chat',
  turn: string | undefined,
  ...entries: BotItemNoteEntry[]
): Row {
  rowAt += 1
  const id = `note-${rowAt}`
  return {
    turn,
    message: {
      id,
      role: 'system',
      timestamp: rowAt,
      source: 'transcript',
      blocks: [],
      botItemNote: { noteId: id, by, entries }
    }
  }
}
const bot = (turn: string | undefined, ...entries: BotItemNoteEntry[]) =>
  note('bot', turn, ...entries)
const prose = (turn = 't1'): Row => ({ turn, message: said(`said-${(rowAt += 1)}`) })
const tool = (turn = 't1'): Row => ({ turn, message: toolCall(`tool-${(rowAt += 1)}`) })
const person = (turn: string): Row => ({
  turn,
  message: {
    id: `user-${(rowAt += 1)}`,
    role: 'user',
    timestamp: rowAt,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Go ahead.' }]
  }
})

const translate = (_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name]))

/** What the chat draws, row by row: each note's lines, chips as <title>, and the rows between. */
function drawn(rows: Row[]): string[] {
  const folded = foldBotItemNotes(
    rows.map((row) => row.message),
    rows.map((row) => row.turn)
  )
  return folded.flatMap((message) => {
    const view = message.botItemNote
    if (!view) {
      return message.role === 'user'
        ? ['person']
        : message.blocks.some((block) => block.type === 'text')
          ? ['prose']
          : message.blocks.length > 0
            ? ['tool']
            : []
    }
    const lines = view.run
      ? [botItemNoteRunLine(view.run, translate)]
      : botItemNoteLines(view, translate)
    return [
      lines
        .map((line) =>
          line.kind === 'line'
            ? [line.lead, ...line.items.map((chip) => `<${chip.title}>`), line.tail, line.detail]
                .filter(Boolean)
                .join(' ')
            : `comment ${line.text}`
        )
        .join(' / ')
    ]
  })
}

describe("the bot's notes in one turn: one row, each item at its final state", () => {
  it('folds across tool work and keeps the first and last journal positions', () => {
    const first = bot('t1', made('win'))
    const last = bot(
      't1',
      moved('win', 'planned', 'working'),
      linked('win', 'working', 'dispatch:ctx_1')
    )
    first.message.journalPosition = { sequence: 3, index: 0 }
    last.message.journalPosition = { sequence: 9, index: 1 }
    const rows = [first, tool(), last, prose()]
    const folded = foldBotItemNotes(
      rows.map((row) => row.message),
      rows.map((row) => row.turn)
    )

    expect(drawn(rows)).toEqual([
      'Added and moved <Windows path casing audit> to In progress',
      'tool',
      'prose'
    ])
    expect(folded[0]!.id).toBe(first.message.id)
    expect(folded[0]!.botItemNote?.at).toBe(last.message.timestamp)
    expect(folded[0]!.journalPosition).toEqual({ sequence: 3, index: 0 })
    expect(folded[0]!.botItemNote?.position).toEqual({ sequence: 9, index: 1 })
  })

  it('groups items by final change while preserving their first appearance', () => {
    expect(
      drawn([
        bot(
          't1',
          moved('win', 'done', 'working'),
          made('rel'),
          made('tok'),
          made('flaky'),
          made('exp')
        ),
        bot('t1', moved('exp', 'planned', 'working'), moved('tok', 'planned', 'working'))
      ])
    ).toEqual([
      'Moved <Windows path casing audit> to In progress / Added <Release notes> <Flaky test sweep> / Added and moved <Token refresh fix> <Export timeout> to In progress'
    ])
  })

  it('stops at an owner note, at prose and at a person', () => {
    expect(
      drawn([
        bot('t1', made('exp')),
        note('owner', 't1', moved('dlg', 'working', 'done')),
        bot('t1', moved('exp', 'planned', 'working'))
      ])
    ).toEqual([
      'Added <Export timeout>',
      'You marked <Share dialog> done',
      'Moved <Export timeout> to In progress'
    ])
    expect(
      drawn([bot('t1', made('login')), prose(), bot('t1', moved('login', 'planned', 'working'))])
    ).toEqual(['Added <Login flaky test>', 'prose', 'Moved <Login flaky test> to In progress'])
  })

  it('stops at a new turn and another chat, and folds nothing without a turn', () => {
    expect(
      drawn([
        bot('t1', made('a1')),
        person('t2'),
        bot('t2', moved('a1', 'planned', 'working')),
        note('other-chat', 't2', commented('a2', 'planned')),
        bot(undefined, moved('a2', 'planned', 'working')),
        bot(undefined, moved('a3', 'planned', 'working'))
      ])
    ).toEqual([
      'Added <a1>',
      'person',
      'Moved <a1> to In progress',
      'Another chat commented on <a2>',
      'Moved <a2> to In progress',
      'Moved <a3> to In progress'
    ])
    expect(drawn([bot('t1', made('a1')), bot('t2', made('a2'))])).toEqual([
      'Added <a1>',
      'Added <a2>'
    ])
  })

  it('renders net bot changes and keeps the owner run separate', () => {
    expect(
      drawn([
        bot('t1', linked('tok', 'working', 'pr:acme/app#812')),
        bot('t1', moved('tok', 'working', 'done'), moved('onb', 'planned', 'working')),
        bot(
          't1',
          moved('onb', 'working', 'planned'),
          commented('onb', 'planned'),
          moved('rel', 'planned', 'working'),
          moved('rel', 'working', 'planned')
        ),
        note('owner', 't1', moved('dlg', 'planned', 'working')),
        note('owner', 't1', moved('dlg', 'working', 'needs_you')),
        note('owner', 't1', moved('dlg', 'needs_you', 'done'))
      ])
    ).toEqual([
      'Marked <Token refresh fix> done / Commented on <Onboarding copy> / Updated <Release notes>',
      'You changed <Share dialog> Planned → Done · 3 changes'
    ])
  })

  it('asks about several items on one line', () => {
    const three = ['long', 'exp', 'share']
    expect(
      drawn([
        bot('t1', ...three.map(made)),
        bot(
          't1',
          ...three.flatMap((uid) => [commented(uid, 'planned'), moved(uid, 'planned', 'needs_you')])
        )
      ])
    ).toEqual([
      'Added and asked you about <Relay director reassigns hosts> <Export timeout> <Share links>'
    ])
  })
})

describe('item rows that touch', () => {
  it('joins quiet notes past hidden rows, but not past prose or an owner’s comment', () => {
    const rows = [
      bot('t1', made('a1')),
      { message: itemMail('mail'), turn: 't1' },
      note('owner', 't1', moved('dlg', 'working', 'done')),
      bot('t1', moved('a1', 'planned', 'working')),
      prose(),
      bot('t1', made('a2')),
      tool(),
      bot('t1', made('a3')),
      note('owner', 't1', commented('a3', 'planned'))
    ]
    const joins = botItemNoteJoins(
      rows.map((row) => row.message),
      (index) => index === 6
    )

    expect(Object.fromEntries(joins)).toEqual({
      0: 'below',
      2: 'both',
      3: 'above',
      5: 'below',
      7: 'above'
    })
  })

  it('keeps a note apart from the next when a turn diff draws under it', () => {
    const rows = [bot('t1', made('a1')), bot('t2', made('a2')), bot('t3', made('a3'))]
    const joins = botItemNoteJoins(
      rows.map((row) => row.message),
      () => false,
      (index) => index === 0
    )

    expect(Object.fromEntries(joins)).toEqual({ 1: 'below', 2: 'above' })
  })
})
