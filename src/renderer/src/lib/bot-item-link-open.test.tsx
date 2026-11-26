// @vitest-environment happy-dom
// Regressions from review of stablyai/orca#49398: which navigation a pending item link yields to.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useBotItemWalk } from '@/components/bots/items/use-bot-item-walk'
import {
  readBotSettingsPlace,
  setBotSettingsPlace
} from '@/components/bots/settings-view/bot-settings-place'
import type { Bot } from '../../../shared/bot-types'
import {
  cancelPendingBotThreadOpen,
  runBotThreadOpen
} from './agent-session/open/bot-thread-open-lifecycle'
import { openLinkedBotItem } from './bot-item-link-open'

const host = vi.hoisted(() => ({ openBotHomeTab: vi.fn() }))
vi.mock('./bot-catalog', () => ({ openBotHomeTab: host.openBotHomeTab }))
vi.mock('@/components/bots/items/use-bot-items', () => ({
  showBotItem: async () => ({ item: { owner: { botId: 'bot-1', name: null } } })
}))

afterEach(() => {
  cancelPendingBotThreadOpen()
  cleanup()
})

it('keeps a pending link when an open item closes on its own', () => {
  let signal: AbortSignal | undefined
  void runBotThreadOpen('link', (pending) => {
    signal = pending
    return new Promise<void>(() => {})
  })
  const list = { groups: {}, closedTotal: 0, loadMoreClosed: null, closedEnded: true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: close() reads nothing of the list.
  const { result } = renderHook(() => useBotItemWalk(list as never, 'bot'))

  act(() => void result.current.close())

  expect(signal?.aborted).toBe(false)
})

it('shows nothing once superseded while the Home was opening', async () => {
  const settings = { botId: 'bot-1', page: null }
  setBotSettingsPlace('panel', settings)
  const controller = new AbortController()
  host.openBotHomeTab.mockImplementation(async () => {
    controller.abort()
    return true
  })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only id and name are read; openBotHomeTab is mocked.
  await openLinkedBotItem({ id: 'bot-1', name: 'Bot' } as Bot, {
    botItemUid: 'item-1',
    signal: controller.signal,
    navigate: (action) => action()
  })

  expect(readBotSettingsPlace('panel')).toBe(settings)
})
