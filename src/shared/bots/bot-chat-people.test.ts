// The Chats tab's person filter: a pick narrows the list and a search's hits to that person's chats,
// the owner's pick to chats that name no teammate, and a person with none says so. Items open on the owner's own.
import { describe, expect, it } from 'vitest'
import type { BotChatPerson, BotChatTreeChat } from './bot-chat-tree'
import { botItemsPersonPick, botPickAccount } from './bot-chat-people'
import { botChatListView, type BotChatSearchState } from './bot-chat-tree-view'

const ALICE = { accountId: 'acc-alice', name: 'Alice Park' }
const ELI = { accountId: 'acc-eli', name: 'Eli Novak' }
const chat = (chatId: string, person?: typeof ALICE): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 1,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...(person ? { person } : {})
})
const CHATS = [chat('home'), chat('a1', ALICE), chat('mine'), chat('a2', ALICE)]
const ids = (view: ReturnType<typeof botChatListView>) => view.found.map((hit) => hit.chat.chatId)

describe('the Chats tab’s person filter', () => {
  const list = (pick: Parameters<typeof botChatListView>[1]['pick']) =>
    botChatListView(CHATS, { steps: 0, query: '', search: null, pick })

  it('narrows the list to the pick', () => {
    expect(ids(list({ kind: 'everyone' }))).toEqual(['home', 'a1', 'mine', 'a2'])
    expect(ids(list({ kind: 'owner' }))).toEqual(['home', 'mine'])
    expect(ids(list({ kind: 'person', person: ALICE }))).toEqual(['a1', 'a2'])
  })

  it('narrows a search’s hits to the pick', () => {
    const search: BotChatSearchState = {
      hits: CHATS.map((entry) => ({ chat: entry, matches: null })),
      more: 0,
      pending: false,
      failed: false
    }
    const view = botChatListView(CHATS, {
      steps: 0,
      query: 'a',
      search,
      pick: { kind: 'person', person: ALICE }
    })
    expect(ids(view)).toEqual(['a1', 'a2'])
    expect(view.noneFromPick).toBe(false)
  })

  it('says a picked person has no chats, and only then', () => {
    expect(list({ kind: 'person', person: ELI })).toMatchObject({ found: [], noneFromPick: true })
    expect(list({ kind: 'person', person: ALICE }).noneFromPick).toBe(false)
    expect(list({ kind: 'everyone' }).noneFromPick).toBe(false)
  })
})

describe("the Items tab's person pick", () => {
  const ALICE_ROW: BotChatPerson = { accountId: 'acct-a', name: 'Alice Park' }

  it("opens a shared bot on the owner's own items", () => {
    const pick = botItemsPersonPick([ALICE_ROW], null)
    expect(pick).toEqual({ kind: 'owner' })
    expect(botPickAccount(pick)).toBeNull()
  })

  it("shows everyone's for a bot shared with no one, as a teammate's copy is, whatever was picked", () => {
    expect(botItemsPersonPick([], null)).toEqual({ kind: 'everyone' })
    expect(botItemsPersonPick([], { kind: 'person', person: ALICE_ROW })).toEqual({
      kind: 'everyone'
    })
    expect(botPickAccount({ kind: 'everyone' })).toBeUndefined()
  })

  it("keeps a picked teammate while they share it, then falls back to the owner's own", () => {
    const picked = { kind: 'person', person: ALICE_ROW } as const
    expect(botItemsPersonPick([ALICE_ROW], picked)).toEqual(picked)
    expect(botPickAccount(picked)).toBe('acct-a')
    expect(botItemsPersonPick([{ accountId: 'acct-b', name: 'Bo' }], picked)).toEqual({
      kind: 'owner'
    })
    expect(botItemsPersonPick([ALICE_ROW], { kind: 'everyone' })).toEqual({ kind: 'everyone' })
  })
})
