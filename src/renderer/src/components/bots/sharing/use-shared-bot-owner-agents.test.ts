// @vitest-environment happy-dom
// The + menu offers what the owner's computer offers now: read on every open, a failed read never kept.
import { renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { useSharedBotOwnerAgents } from './use-shared-bot-owner-agents'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only the bot's host and id.
const ivy = {
  id: 'ivy',
  name: 'Ivy',
  hostId: 'runtime:env-shared',
  agent: 'claude'
} as unknown as Bot

it('reads the owner’s agents each time the menu opens, and a failed read is never kept', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The owner's computer doesn't answer the first read: nothing kept, so the next open asks again.
  mocks.call.mockRejectedValueOnce(new Error('offline'))
  const { result, rerender } = renderHook(
    ({ open }: { open: boolean }) => useSharedBotOwnerAgents(ivy, true, open),
    { initialProps: { open: true } }
  )
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  expect(result.current).toBeNull()

  mocks.call.mockResolvedValueOnce({ newChatAgents: [{ agent: 'claude' }, { agent: 'codex' }] })
  rerender({ open: false })
  rerender({ open: true })
  await waitFor(() => expect(result.current).toEqual([{ agent: 'claude' }, { agent: 'codex' }]))

  // The owner turned Codex off since: the next open shows that.
  mocks.call.mockResolvedValueOnce({ newChatAgents: [{ agent: 'claude' }] })
  rerender({ open: false })
  rerender({ open: true })
  await waitFor(() => expect(result.current).toEqual([{ agent: 'claude' }]))
  expect(mocks.call).toHaveBeenCalledTimes(3)
})
