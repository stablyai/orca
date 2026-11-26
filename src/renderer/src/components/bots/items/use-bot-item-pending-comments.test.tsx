// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botItemAskText } from '../../../../../shared/bots/bot-item-ask'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { readNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { writeNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { useBotItemPendingComments } from './use-bot-item-pending-comments'
import { useBotItemView } from './use-bot-item-view'

const host = vi.hoisted(() => ({
  showBotItem: vi.fn(),
  commentOnBotItem: vi.fn()
}))
vi.mock('./use-bot-items', () => ({
  showBotItem: host.showBotItem,
  commentOnBotItem: host.commentOnBotItem
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../bot-host-capability', () => ({ botHostTakes: () => true }))
vi.mock('../bot-presentation', () => ({ botErrorMessage: (error: unknown) => String(error) }))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))

const NOW = 1_800_000_000_000
const bot = { id: 'agent', hostId: 'local' } as const
const AGENT = { kind: 'bot', botId: 'agent', chatId: 'chat' } as const

function askEvent(id: string, prompt: string): BotItemEvent {
  const ask = { questions: [{ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }] }
  return { id, kind: 'commented', actor: AGENT, data: { text: botItemAskText(ask), ask }, at: NOW }
}

function itemAsking(uid: string, ask: BotItemEvent): BotItem {
  return {
    uid,
    number: 1,
    owner: { botId: 'agent', name: null },
    title: 'Ship it',
    description: null,
    doneMeans: null,
    status: 'needs_you',
    chat: { id: 'chat', kind: 'home', title: null },
    madeBy: null,
    question: { eventId: ask.id, text: String(ask.data.text) },
    waitingAsk: ask.id,
    closeNote: null,
    wait: null,
    links: [],
    version: 1,
    lastEventId: ask.id,
    othersLastEventId: ask.id,
    snoozedUntil: null,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null
  }
}

// Each item as its host has it now; a read returns it.
// Item uids differ per test: the views' last-read cache outlives a mount.
const items = new Map<string, { item: BotItem; events: BotItemEvent[] }>()
let readFails = false
const reads = (uid: string): number =>
  host.showBotItem.mock.calls.filter(([, read]) => read === uid).length

function hostAsks(uid: string, ask: BotItemEvent): void {
  const now = items.get(uid)
  items.set(uid, { item: itemAsking(uid, ask), events: [...(now?.events ?? []), ask] })
}

// A reply on its way: the test settles it when the host answers.
let settle: { refuse: (code: string) => void } | null = null

beforeEach(() => {
  vi.clearAllMocks()
  items.clear()
  readFails = false
  host.showBotItem.mockImplementation(
    async (_bot: unknown, uid: string, page: { after?: string }) => {
      if (readFails) {
        throw new Error('offline')
      }
      const { item, events } = items.get(uid)!
      const after = page.after ? Number(page.after.slice(1)) : -1
      return { item, events: events.filter(({ id }) => Number(id.slice(1)) >= after) }
    }
  )
  host.commentOnBotItem.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        settle = {
          refuse: (code) => reject(Object.assign(new Error(code), { code }))
        }
      })
  )
})
afterEach(cleanup)

// The item's view and its sent comments, as BotItemView holds them.
function openItem(uid: string) {
  return renderHook(() => {
    const view = useBotItemView(bot, uid)
    const pending = useBotItemPendingComments(bot, uid, view.events)
    return { view, pending }
  })
}

async function shown(
  hook: ReturnType<typeof openItem>,
  check: (view: ReturnType<typeof openItem>['result']['current']['view']) => boolean
): Promise<void> {
  await waitFor(() => expect(check(hook.result.current.view)).toBe(true))
}

// A reply to the first ask, held on its way while the item is left and opened again (its view reads
// the first ask once more); then the agent asks again, its change notice not here yet.
async function replyHeldAcrossReopen(uid: string, typedSince = '') {
  hostAsks(uid, askEvent('e2', 'Merge PR #22?'))
  const first = openItem(uid)
  await shown(first, (view) => view.eventsRead)
  act(() => first.result.current.pending.send('Yes', [], 'e2', 'e2'))
  await waitFor(() => expect(host.commentOnBotItem).toHaveBeenCalledTimes(1))
  first.unmount()
  const reopened = openItem(uid)
  await waitFor(() => expect(reads(uid)).toBe(2))
  await shown(reopened, (view) => view.item?.waitingAsk === 'e2')
  hostAsks(uid, askEvent('e3', 'Merge PR #22 and #23?'))
  writeNativeChatDraftCache(botItemCommentDraftScope(bot, uid), typedSince)
  return reopened
}

it('reads the later ask into the view open now when a reply sent from a closed one is refused', async () => {
  const uid = 'reopened'
  hostAsks('other', askEvent('e2', 'Ship the docs?'))
  const other = openItem('other')
  await shown(other, (view) => view.eventsRead)
  const reopened = await replyHeldAcrossReopen(uid)
  const otherReads = reads('other')
  await act(async () => settle!.refuse('item_changed'))
  await shown(reopened, (view) => view.item?.waitingAsk === 'e3')
  expect(reopened.result.current.view.events.map(({ id }) => id)).toEqual(['e2', 'e3'])
  // Not sent again: the words go back to the empty box for the owner to send.
  expect(host.commentOnBotItem).toHaveBeenCalledTimes(1)
  expect(reopened.result.current.pending.shown).toEqual([])
  expect(readNativeChatComposerDraft(botItemCommentDraftScope(bot, uid)).text).toBe('Yes')
  // Another item's view reads nothing.
  expect(reads('other')).toBe(otherReads)
})

it('keeps what the owner typed since, and still reads the later ask', async () => {
  const uid = 'typed'
  const reopened = await replyHeldAcrossReopen(uid, 'something else')
  await act(async () => settle!.refuse('item_changed'))
  await shown(reopened, (view) => view.item?.waitingAsk === 'e3')
  expect(readNativeChatComposerDraft(botItemCommentDraftScope(bot, uid)).text).toBe(
    'something else'
  )
  expect(host.commentOnBotItem).toHaveBeenCalledTimes(1)
})

it('offers Retry when the read after a refusal fails, and reads the later ask on it', async () => {
  const uid = 'read-fails'
  const reopened = await replyHeldAcrossReopen(uid)
  readFails = true
  await act(async () => settle!.refuse('item_changed'))
  await shown(reopened, (view) => view.failed)
  readFails = false
  act(() => reopened.result.current.view.retry())
  await shown(reopened, (view) => view.item?.waitingAsk === 'e3' && !view.failed)
  expect(host.commentOnBotItem).toHaveBeenCalledTimes(1)
})

it('reads the later ask in the same view, and leaves other failures to Retry', async () => {
  const uid = 'same-view'
  hostAsks(uid, askEvent('e2', 'Merge PR #22?'))
  const view = openItem(uid)
  await shown(view, (read) => read.eventsRead)
  act(() => view.result.current.pending.send('No', [], 'e2', 'e2'))
  await waitFor(() => expect(host.commentOnBotItem).toHaveBeenCalledTimes(1))
  const before = reads(uid)
  await act(async () => settle!.refuse('unavailable'))
  // An ordinary failure stays with Retry; nothing is read.
  await waitFor(() => expect(view.result.current.pending.shown[0]?.failed).toBe(true))
  expect(reads(uid)).toBe(before)
  act(() => view.result.current.pending.retry(view.result.current.pending.shown[0]!.event.id))
  await waitFor(() => expect(host.commentOnBotItem).toHaveBeenCalledTimes(2))
  hostAsks(uid, askEvent('e3', 'Merge PR #22 and #23?'))
  await act(async () => settle!.refuse('item_changed'))
  await shown(view, (read) => read.item?.waitingAsk === 'e3')
})
