// The Chats tab's person filter: a pick narrows the list and a search's hits to that person's chats,
// the owner's pick to chats that name no teammate, and a person with none says so. Items open on the owner's own.
import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from './bot-chat-tree'
import {
  botItemPersonMark,
  botItemsPersonPick,
  botItemsWhoseOfPick,
  botPeoplePicker,
  botPickedOther
} from './bot-chat-people'
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
  const share = (accountId: string, name: string) => ({
    kind: 'account' as const,
    shareId: `s-${accountId}`,
    accountId,
    name,
    email: `${accountId}@example.com`,
    addedAt: 1,
    acceptedAt: 2
  })
  const OWNERS_COPY = { shares: [share('acct-a', 'Alice Park'), share('acct-b', 'Bo Chen')] }
  // Alice's copy, as the host lists it to her share device.
  const ALICES_COPY = {
    shareViewer: {
      accountId: 'acct-a',
      ownerName: 'Jinwoo',
      teammates: [
        { accountId: 'acct-a', name: 'Alice Park' },
        { accountId: 'acct-b', name: 'Bo Chen' }
      ]
    }
  }
  const names = (entries: ReturnType<typeof botPeoplePicker>) =>
    entries?.map((entry) => `${entry.pick.kind}:${entry.name}`)

  it("opens the owner's copy on their own items, then the teammates", () => {
    const entries = botPeoplePicker(OWNERS_COPY, 'Jinwoo')
    expect(names(entries)).toEqual(['owner:Jinwoo', 'person:Alice Park', 'person:Bo Chen'])
    const pick = botItemsPersonPick(entries, null)
    expect(pick).toEqual({ kind: 'owner' })
    expect(botItemsWhoseOfPick(pick, OWNERS_COPY)).toBe('owner')
    // Everyone is the owner's default list: one read, not a second of the same rows.
    expect(botItemsWhoseOfPick({ kind: 'everyone' }, OWNERS_COPY)).toBe('default')
  })

  it("opens a teammate's copy on their own items: 'you' is the teammate, then the owner and the rest", () => {
    const entries = botPeoplePicker(ALICES_COPY, null)
    expect(names(entries)).toEqual(['person:Alice Park', 'owner:Jinwoo', 'person:Bo Chen'])
    const pick = botItemsPersonPick(entries, null)
    // Her own is her default list: one read, not a second of the same rows.
    expect(botItemsWhoseOfPick(pick, ALICES_COPY)).toBe('default')
    expect(botItemsWhoseOfPick({ kind: 'everyone' }, ALICES_COPY)).toBe('everyone')
    expect(botItemsWhoseOfPick({ kind: 'owner' }, ALICES_COPY)).toBe('owner')
  })

  it('reads an agent shared with no one as its default list, with no pick', () => {
    expect(botPeoplePicker({}, 'Jinwoo')).toBeNull()
    expect(botItemsPersonPick(null, { kind: 'owner' })).toEqual({ kind: 'everyone' })
    expect(botItemsWhoseOfPick({ kind: 'everyone' }, {})).toBe('default')
  })

  it("keeps a picked person while they share it, then falls back to the viewer's own", () => {
    const entries = botPeoplePicker(ALICES_COPY, null)
    const bo = { kind: 'person', person: { accountId: 'acct-b', name: 'Bo Chen' } } as const
    expect(botItemsPersonPick(entries, bo)).toEqual(bo)
    const gone = { kind: 'person', person: { accountId: 'acct-z', name: 'Zed' } } as const
    expect(botItemsWhoseOfPick(botItemsPersonPick(entries, gone), ALICES_COPY)).toBe('default')
  })
})

describe('whom an Items empty list and row names, as each viewer sees it', () => {
  const alice = { accountId: 'acct-a', name: 'Alice Park' }
  const bo = { accountId: 'acct-b', name: 'Bo Chen' }
  const VIEWER = { accountId: 'acct-a', ownerName: 'Jinwoo', teammates: [alice, bo] }
  const label = (
    entries: ReturnType<typeof botPeoplePicker>,
    pick: Parameters<typeof botPickedOther>[0]
  ) => botPickedOther(pick, entries)?.name ?? null

  it("names a picked person other than the viewer, never the viewer's own", () => {
    const teammates = botPeoplePicker({ shareViewer: VIEWER }, null)
    expect(label(teammates, { kind: 'person', person: alice })).toBeNull()
    expect(label(teammates, { kind: 'owner' })).toBe('Jinwoo')
    expect(label(teammates, { kind: 'person', person: bo })).toBe('Bo Chen')
    expect(label(teammates, { kind: 'everyone' })).toBeNull()
    const owners = botPeoplePicker({ shares: [] }, 'Jinwoo')
    expect(owners).toBeNull()
  })

  it("marks Everyone's rows with anyone's but the viewer's own", () => {
    const ownersItem = {}
    const alicesItem = { people: [alice] }
    const shared = { people: [alice, bo] }
    expect(botItemPersonMark(ownersItem, undefined, 'Owner')).toBeNull()
    expect(botItemPersonMark(alicesItem, undefined, 'Owner')).toBe('Alice Park')
    expect(botItemPersonMark(ownersItem, VIEWER, 'Owner')).toBe('Jinwoo')
    expect(botItemPersonMark(ownersItem, { ...VIEWER, ownerName: null }, 'Owner')).toBe('Owner')
    expect(botItemPersonMark(alicesItem, VIEWER, 'Owner')).toBeNull()
    expect(botItemPersonMark(shared, VIEWER, 'Owner')).toBe('Bo Chen')
  })
})
