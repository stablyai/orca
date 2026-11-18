// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const item = (status: BotItem['status']): BotItem =>
  makeTestBotItem(1, { uid: 'item-1', title: 'Share dialog', status })

const host = vi.hoisted(() => ({ show: vi.fn() }))

// The Items tab still holds the item as In progress; the host has it Done.
vi.mock('@/components/bots/items/use-bot-items', () => ({
  botItemLastRead: () => item('working'),
  showBotItem: host.show
}))

import { useBotItemChipPreview } from './bot-item-chip-preview'

afterEach(cleanup)

it('reads the item fresh each time the preview opens, even with the Items tab’s read at hand', async () => {
  host.show.mockResolvedValue({ item: item('done'), events: [] })
  const bot = { hostId: 'local', id: 'bot-1' } as const

  const first = renderHook(() => useBotItemChipPreview(bot, 'item-1'))
  await waitFor(() => expect(first.result.current?.status).toBe('done'))
  first.unmount()
  renderHook(() => useBotItemChipPreview(bot, 'item-1'))

  await waitFor(() => expect(host.show).toHaveBeenCalledTimes(2))
})
