// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'

const sent = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-items', () => ({ commentOnBotItem: sent }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { useBotItemPendingComments } from './use-bot-item-pending-comments'

// A paired host that hasn't said it takes request ids: a refused comment matches by its text.
const BOT: BotRef = { id: 'bot-a', hostId: 'runtime:env-old' }
const LOCAL: BotRef = { id: 'bot-a', hostId: 'local' }

function owner(id: string, text: string): BotItemEvent {
  return { id, kind: 'commented', actor: { kind: 'owner' }, data: { text }, at: 1 }
}

function mount(uid: string, bot = BOT) {
  const initialProps: { events: BotItemEvent[] } = { events: [] }
  return renderHook(({ events }) => useBotItemPendingComments(bot, uid, events), {
    initialProps
  })
}

it('shows a sent comment until the read has its event, and keeps a refused one for Retry', async () => {
  let answer: (value: unknown) => void = () => {}
  sent.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  const view = mount('uid-6')

  act(() => view.result.current.send('Ship it', [], 'e8'))
  expect(view.result.current.shown.map((entry) => entry.event.data.text)).toEqual(['Ship it'])

  await act(async () => answer({ eventId: 'e9' }))
  expect(view.result.current.shown).toHaveLength(1)
  view.rerender({ events: [owner('e9', 'Ship it')] })
  expect(view.result.current.shown).toEqual([])

  sent.mockRejectedValueOnce(new Error('offline'))
  await act(async () => view.result.current.send('Again', [], 'e9'))
  const [refused] = view.result.current.shown
  expect(refused?.failed).toBe(true)

  sent.mockResolvedValueOnce({ eventId: 'e10' })
  await act(async () => view.result.current.retry(refused!.event.id))
  expect(sent).toHaveBeenLastCalledWith(BOT, 'uid-6', 'Again', [], undefined)
  expect(view.result.current.shown[0]?.failed).toBe(false)
})

it('keeps a refused comment when the item is left and opened again', async () => {
  sent.mockRejectedValueOnce(new Error('offline'))
  const first = mount('uid-7')
  await act(async () => first.result.current.send('Keep me', [], 'e1'))
  first.unmount()

  const again = mount('uid-7')
  expect(again.result.current.shown.map((entry) => [entry.event.data.text, entry.failed])).toEqual([
    ['Keep me', true]
  ])
})

it('drops a failed comment the host stored anyway, so Retry cannot store it twice', async () => {
  sent.mockRejectedValueOnce(new Error('timed out'))
  const view = mount('uid-8')
  await act(async () => view.result.current.send('Option A', [], 'e3'))
  expect(view.result.current.shown).toHaveLength(1)

  // An identical comment from before the send is not this one.
  view.rerender({ events: [owner('e2', 'Option A')] })
  expect(view.result.current.shown).toHaveLength(1)
  view.rerender({ events: [owner('e2', 'Option A'), owner('e4', 'Option A')] })
  expect(view.result.current.shown).toEqual([])
})

it("never lets a second identical comment take the first one's event", async () => {
  let refuseB: (error: unknown) => void = () => {}
  sent.mockResolvedValueOnce({ eventId: 'e2' })
  sent.mockReturnValueOnce(new Promise((_, reject) => (refuseB = reject)))
  const view = mount('uid-9')
  await act(async () => {
    view.result.current.send('ok', [], 'e1')
    view.result.current.send('ok', [], 'e1')
  })

  // A's read lands while B is still in flight.
  view.rerender({ events: [owner('e2', 'ok')] })
  expect(view.result.current.shown).toHaveLength(1)
  await act(async () => refuseB(new Error('offline')))
  view.rerender({ events: [owner('e2', 'ok')] })
  expect(view.result.current.shown.map((entry) => entry.failed)).toEqual([true])
})

it('matches a refused image comment by its image count, one event each', async () => {
  sent.mockRejectedValueOnce(new Error('timed out'))
  sent.mockRejectedValueOnce(new Error('timed out'))
  const view = mount('uid-10')
  await act(async () => {
    view.result.current.send('', ['/store/a.png'], 'e1')
    view.result.current.send('', ['/store/b.png'], 'e1')
  })
  expect(view.result.current.shown).toHaveLength(2)

  const stored: BotItemEvent = {
    ...owner('e2', ''),
    data: { text: '', images: [{ path: '/store/a.png', name: 'a.png', bytes: 3 }] }
  }
  view.rerender({ events: [owner('e3', ''), stored] })
  expect(view.result.current.shown).toHaveLength(1)
  view.rerender({ events: [owner('e3', ''), stored] })
  expect(view.result.current.shown).toHaveLength(1)
})

it("still matches an earlier timed-out comment when a later one's answer names a newer event", async () => {
  sent.mockRejectedValueOnce(new Error('timed out'))
  sent.mockResolvedValueOnce({ eventId: 'e3' })
  const view = mount('uid-11')
  await act(async () => {
    view.result.current.send('X', [], 'e1')
    view.result.current.send('A', [], 'e1')
  })
  expect(view.result.current.shown.map((entry) => entry.failed)).toEqual([true, false])

  // The host stored X as e2 after all; one read brings both.
  view.rerender({ events: [owner('e2', 'X'), owner('e3', 'A')] })
  expect(view.result.current.shown).toEqual([])
})

it('on a host that takes request ids, a Retry resends the same id and the read matches by it', async () => {
  sent.mockRejectedValueOnce(new Error('timed out'))
  const view = mount('uid-12', LOCAL)
  await act(async () => view.result.current.send('ok', [], 'e1'))
  const requestId = sent.mock.lastCall?.[4]
  expect(requestId).toEqual(expect.any(String))

  // An identical comment without this id is someone else's.
  view.rerender({ events: [owner('e2', 'ok')] })
  expect(view.result.current.shown).toHaveLength(1)

  sent.mockResolvedValueOnce({ eventId: 'e3' })
  await act(async () => view.result.current.retry(view.result.current.shown[0]!.event.id))
  expect(sent.mock.lastCall?.[4]).toBe(requestId)
  view.rerender({
    events: [owner('e2', 'ok'), { ...owner('e3', 'ok'), data: { text: 'ok', requestId } }]
  })
  expect(view.result.current.shown).toEqual([])
})
