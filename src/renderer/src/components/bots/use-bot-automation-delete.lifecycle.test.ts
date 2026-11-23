// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotAutomationDeleteIntent } from './use-bot-automation-delete'
import { useBotAutomationDelete } from './use-bot-automation-delete'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps a delete intent and its completion within the bot visit that created it', async () => {
  const local: BotRef = { hostId: 'local', id: 'b1' }
  const paired: BotRef = { hostId: 'runtime:paired', id: 'b1' }
  const replies: (() => void)[] = []
  vi.stubGlobal('api', {
    runtime: {
      call: () => new Promise((resolve) => replies.push(() => resolve({ ok: true, result: {} })))
    }
  })
  const activity = {
    read: null,
    refresh: () => {},
    refreshSettled: async () => ({ ok: false as const })
  }
  const { result, rerender } = renderHook((bot) => useBotAutomationDelete(bot, activity, false), {
    initialProps: local
  })
  const intent = (): BotAutomationDeleteIntent => ({
    id: 'digest',
    name: 'Digest',
    authority: { kind: 'local' },
    botKey: result.current.botKey,
    generation: result.current.generation,
    admittedAsTrouble: false
  })
  const old = intent()
  act(() => {
    expect(result.current.admit(old)).not.toBeNull()
  })
  rerender(paired)
  rerender(local)
  act(() => {
    expect(result.current.admit(old)).toBeNull()
  })
  let current: number | null = null
  act(() => {
    current = result.current.admit(intent())
  })
  expect(current).not.toBeNull()
  expect(replies).toHaveLength(2)
  await act(async () => replies[0]())
  expect([...result.current.pendingOpIds]).toEqual([current])
})
