// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const show = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-items', () => ({ showBotItem: show }))

import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { useBotItemView } from './use-bot-item-view'

const BOT: BotRef = { id: 'bot-a', hostId: 'local' }
const event: BotItemEvent = {
  id: 'e5',
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text: 'hi' },
  at: 1
}

function mount(uid: string, listed?: ReturnType<typeof makeTestBotItem>) {
  return renderHook(() => useBotItemView(BOT, uid, listed))
}

it('seeds the view immediately, preserves it on an empty refresh and reopens from its last event', async () => {
  const item = makeTestBotItem(11)
  show.mockResolvedValueOnce({ item, events: [event] })
  const first = mount(item.uid, item)
  expect(first.result.current.item).toBe(item)
  expect(first.result.current.eventsRead).toBe(false)
  await waitFor(() => expect(first.result.current.events).toEqual([event]))
  const shown = first.result.current

  show.mockResolvedValueOnce({ item: { ...item }, events: [] })
  await act(async () => {
    emitBotsChangedWindowEvent('local', { botIds: [BOT.id], kinds: ['items'] })
  })
  await waitFor(() => expect(show).toHaveBeenCalledTimes(2))
  expect(first.result.current.item).toBe(shown.item)
  expect(first.result.current.events).toBe(shown.events)
  first.unmount()

  show.mockReturnValueOnce(new Promise(() => {}))
  const again = mount(item.uid)
  expect(again.result.current.events).toEqual([event])
  expect(again.result.current.eventsRead).toBe(true)
  expect(show).toHaveBeenLastCalledWith(BOT, item.uid, { after: 'e5' })
})
