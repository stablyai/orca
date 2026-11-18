import { describe, expect, it } from 'vitest'
import { botItemNoteEntry, type BotItemNoteEntry } from './bot-item-note'
import type { BotItemLinkView } from './bot-items'
import { botItemNoteLines } from './bot-item-note-lines'

const translate = (_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name]))

const a = { uid: 'a', number: 1, title: 'Share links', status: 'working' as const }
const b = { uid: 'b', number: 2, title: 'Share dialog', status: 'working' as const }
type Status = BotItemNoteEntry['status']
const made = (item: typeof a, at: Status = 'planned'): BotItemNoteEntry => ({
  ...item,
  status: at,
  event: 'made'
})
const comment = (item: typeof a, at: Status = item.status): BotItemNoteEntry => ({
  ...item,
  status: at,
  event: 'commented',
  text: '**Suggestions:** agreed'
})
const move = (item: typeof a, from: Status, to: Status): BotItemNoteEntry => ({
  ...item,
  status: to,
  event: 'status',
  from,
  to
})
const link = (item: typeof a, at: Status): BotItemNoteEntry => ({
  ...item,
  status: at,
  event: 'linked',
  refs: ['pr:acme/app#812']
})

function said(entries: BotItemNoteEntry[], t: typeof translate = translate): string[] {
  return botItemNoteLines({ noteId: 'n', by: 'bot', entries }, t).map((line) =>
    line.kind === 'line'
      ? [line.lead, line.items.map((item) => `<${item.title} ${item.status}>`).join(' '), line.tail]
          .filter(Boolean)
          .join(' ') + (line.detail === undefined ? '' : `: ${line.detail}`)
      : `comment ${line.text}`
  )
}

describe("the bot's writes in a chat: each item once, at its final state", () => {
  it('prefixes Added when the run made it', () => {
    expect(said([made(a), move(a, 'planned', 'working'), link(a, 'working')])).toEqual([
      'Added and moved <Share links working> to In progress'
    ])
    expect(said([made(a), comment(a, 'planned')])).toEqual(['Added <Share links planned>'])
    expect(said([made(a), move(a, 'planned', 'done')])).toEqual([
      'Added and marked <Share links done> done'
    ])
    expect(said([made(a), move(a, 'planned', 'canceled')])).toEqual([
      'Added and canceled <Share links canceled>'
    ])
  })

  it('asks only from Needs you with its question: the write’s comment just before the move, or one after', () => {
    expect(said([made(a), comment(a, 'planned'), move(a, 'planned', 'needs_you')])).toEqual([
      'Added and asked you about <Share links needs_you>'
    ])
    expect(said([made(a), move(a, 'planned', 'needs_you'), comment(a, 'needs_you')])).toEqual([
      'Added and asked you about <Share links needs_you>'
    ])
    expect(said([made(a, 'needs_you'), comment(a, 'needs_you')])).toEqual([
      'Added and asked you about <Share links needs_you>'
    ])
    expect(said([comment(a), move(a, 'working', 'needs_you')])).toEqual([
      'Asked you about <Share links needs_you>'
    ])
    expect(said([move(a, 'needs_you', 'needs_you'), comment(a, 'needs_you')])).toEqual([
      'Asked you about <Share links needs_you>'
    ])
    expect(said([comment(a), link(a, 'working'), move(a, 'working', 'needs_you')])).toEqual([
      'Moved <Share links needs_you> to Needs you'
    ])
  })

  it('says where the item ended, not the first thing that happened to it', () => {
    expect(said([move(a, 'done', 'working')])).toEqual([
      'Moved <Share links working> to In progress'
    ])
    expect(said([move(a, 'working', 'done'), move(a, 'done', 'canceled')])).toEqual([
      'Canceled <Share links canceled>'
    ])
    expect(said([link(a, 'working'), move(a, 'working', 'done')])).toEqual([
      'Marked <Share links done> done'
    ])
    expect(said([move(a, 'planned', 'working'), comment(a, 'working')])).toEqual([
      'Moved <Share links working> to In progress'
    ])
  })

  it('treats a round trip back to where it started as no move', () => {
    const there = move(a, 'planned', 'working')
    const back = move(a, 'working', 'planned')
    expect(said([there, back, comment(a, 'planned')])).toEqual([
      'Commented on <Share links planned>'
    ])
    expect(said([there, back])).toEqual(['Updated <Share links planned>'])
  })

  it('shares a line between items that ended the same way, in the order they first appear', () => {
    expect(said([comment(a), comment(b)])).toEqual([
      'Commented on <Share links working> <Share dialog working>'
    ])
    expect(
      said([made(a), made(b), move(b, 'planned', 'working'), move(a, 'planned', 'working')])
    ).toEqual(['Added and moved <Share links working> <Share dialog working> to In progress'])
    expect(said([made(a), made(b), move(b, 'planned', 'working')])).toEqual([
      'Added <Share links planned>',
      'Added and moved <Share dialog working> to In progress'
    ])
  })

  it('splits a translated sentence wherever it puts the chips', () => {
    const korean = (key: string, fallback: string, values?: Record<string, unknown>) =>
      translate(
        key,
        key === 'bots.items.chat.addedAndMoved'
          ? '{{items}} 항목을 추가하고 {{status}}(으)로 옮겼어요'
          : fallback,
        values
      )
    const [line] = botItemNoteLines(
      { noteId: 'n', by: 'bot', entries: [made(a), move(a, 'planned', 'working')] },
      korean
    )
    expect(line).toMatchObject({ lead: '', tail: '항목을 추가하고 In progress(으)로 옮겼어요' })
  })
})

describe('a bot write that only links', () => {
  const pr = (ref: string): BotItemLinkView => ({ kind: 'pr', ref, pr: null })
  const worker = (ref: string, title: string | null): BotItemLinkView => ({
    kind: 'dispatch',
    ref,
    latest: null,
    title,
    state: 'working',
    host: null,
    startedAt: null,
    settledAt: null,
    report: null,
    pr: null
  })
  const home = [pr('acme/app#700'), pr('acme/app#701')]
  const linked = (
    item: typeof a,
    refs: string[],
    links: BotItemLinkView[] = home
  ): BotItemNoteEntry => botItemNoteEntry({ kind: 'linked', data: { links: refs } }, item, links)!

  it('names the one link it added', () => {
    expect(said([linked(a, ['pr:acme/app#786'])])).toEqual(['Linked #786 to <Share links working>'])
    expect(said([linked(a, ['pr:other/lib#5'])])).toEqual([
      'Linked other/lib#5 to <Share links working>'
    ])
    expect(said([linked(a, ['url:https://github.com/acme/app/issues/12'])])).toEqual([
      'Linked #12 to <Share links working>'
    ])
    expect(said([linked(a, ['url:https://linear.app/acme/issue/eng-42/share'])])).toEqual([
      'Linked ENG-42 to <Share links working>'
    ])
    expect(said([linked(a, ['url:https://www.example.com/docs/share'])])).toEqual([
      'Linked example.com to <Share links working>'
    ])
    expect(said([linked(a, ['file:/Users/me/notes/plan.md'])])).toEqual([
      'Linked plan.md to <Share links working>'
    ])
    expect(said([linked(a, ['dispatch:ctx_1'], [worker('ctx_1', 'Fix share copy')])])).toEqual([
      'Linked Fix share copy to <Share links working>'
    ])
    expect(said([linked(a, ['dispatch:ctx_1'], [worker('ctx_1', null)])])).toEqual([
      'Linked a worker to <Share links working>'
    ])
  })

  it('counts several links, and folds items linked to the same thing', () => {
    expect(
      said([linked(a, ['pr:acme/app#786', 'file:plan.md', 'url:https://example.com'])])
    ).toEqual(['Linked 3 links to <Share links working>'])
    expect(said([linked(a, ['pr:acme/app#786']), linked(b, ['pr:acme/app#786'])])).toEqual([
      'Linked #786 to <Share links working> <Share dialog working>'
    ])
  })

  it('names links in a note written before names were kept', () => {
    expect(said([{ ...a, event: 'linked', refs: ['pr:other/lib#5'] }])).toEqual([
      'Linked #5 to <Share links working>'
    ])
  })

  it('stays Commented on when the write also commented', () => {
    expect(said([comment(a), linked(a, ['pr:acme/app#786'])])).toEqual([
      'Commented on <Share links working>'
    ])
  })
})

describe("another chat's write, in the chat whose item it changed", () => {
  const chat = { kind: 'chat' as const, chatId: 'chat-a', title: 'Debug Slack replies' }
  const lines = (by: Parameters<typeof botItemNoteLines>[0]['by'], entries: BotItemNoteEntry[]) =>
    botItemNoteLines({ noteId: 'n', by, entries }, translate).map((line) =>
      line.kind === 'line'
        ? [
            line.lead,
            line.chat && `[${line.chat.name} ${line.chat.chatId}]`,
            line.chat?.after,
            line.items.map((item) => `<${item.title} ${item.status}>`).join(' '),
            line.tail
          ]
            .filter(Boolean)
            .join(' ')
        : `comment ${line.text}`
    )

  it('names the acting chat as a chip before the item', () => {
    expect(lines(chat, [move(a, 'working', 'done')])).toEqual([
      '[Debug Slack replies chat-a] marked <Share links done> done'
    ])
    expect(lines(chat, [comment(a)])).toEqual([
      '[Debug Slack replies chat-a] commented on <Share links working>'
    ])
    expect(lines(chat, [move(a, 'planned', 'working')])).toEqual([
      '[Debug Slack replies chat-a] moved <Share links working> to In progress'
    ])
  })

  it('marks a Home Chat chip, which opens its live session', () => {
    const [line] = botItemNoteLines(
      { noteId: 'n', by: { ...chat, title: null, home: true }, entries: [comment(a)] },
      translate
    )
    expect(line?.kind === 'line' && line.chat).toEqual({
      chatId: 'chat-a',
      name: 'Home Chat',
      after: 'commented on',
      home: true
    })
  })

  it('names Home Chat by its name, and an untitled chat as another chat', () => {
    expect(lines({ ...chat, title: null, home: true }, [comment(a)])).toEqual([
      '[Home Chat chat-a] commented on <Share links working>'
    ])
    expect(lines({ ...chat, title: null }, [comment(a)])).toEqual([
      '[Another chat chat-a] commented on <Share links working>'
    ])
  })

  it('says another chat, without a chip, when the chat was gone or the note is older', () => {
    expect(lines('other-chat', [move(a, 'working', 'canceled')])).toEqual([
      'Another chat canceled <Share links canceled>'
    ])
  })

  it("keeps the bot's own wording for the chat that wrote it", () => {
    expect(lines('bot', [move(a, 'working', 'done')])).toEqual(['Marked <Share links done> done'])
  })
})
