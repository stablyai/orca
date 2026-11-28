// @vitest-environment happy-dom
// A scoped read's failure belongs to the scope that failed: switching picks never carries it over.
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItemsWhose } from '../../../../../shared/bots/bot-chat-people'
import type { BotRef } from '@/lib/bot-hosts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { useBotChatItems } from './use-bot-items'

const host = vi.hoisted(() => ({ callBotRpc: vi.fn() }))
vi.mock('@/lib/bot-hosts', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  callBotRpc: host.callBotRpc
}))
vi.mock('@/lib/bots-changed-window-event', () => ({ onBotsChanged: () => () => {} }))

afterEach(() => {
  cleanup()
  host.callBotRpc.mockReset()
})

it("drops a failed pick's failure on switching to another, before that one lands", async () => {
  host.callBotRpc.mockImplementation(
    (_bot: unknown, _method: string, params: { person?: string | null }) =>
      params.person === 'acct-a' ? Promise.reject(new Error('down')) : new Promise(() => {})
  )
  const bot: BotRef = { hostId: LOCAL_EXECUTION_HOST_ID, id: 'agent-1' }
  const { result, rerender } = renderHook(
    ({ whose }: { whose: BotItemsWhose }) => useBotChatItems(bot, null, whose),
    { initialProps: { whose: 'person:acct-a' } }
  )
  await waitFor(() => expect(result.current.failed).toBe(true))
  rerender({ whose: 'owner' })
  expect(result.current.failed).toBe(false)
  expect(result.current.read).toBeNull()
})
