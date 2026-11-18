// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Call = { botIds?: string[] }
const calls: Call[] = []
let answers: Record<string, string>
let gate: Promise<void> = Promise.resolve()
let failNext = false

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, _method: string, params?: Call) => {
    calls.push(params ?? {})
    await gate
    if (failNext) {
      failNext = false
      throw new Error('timed out')
    }
    const named = params?.botIds
    return {
      values: Object.fromEntries(
        Object.entries(answers).filter(([botId]) => !named || named.includes(botId))
      )
    }
  }
}))
vi.mock('./bot-hosts', () => ({
  botHostTarget: () => ({ kind: 'local' }),
  forEachBotHost: async (each: (host: { hostId: 'local' }) => Promise<void>) =>
    each({ hostId: 'local' })
}))

import { emitBotsChangedWindowEvent } from './bots-changed-window-event'
import { createBotHostPerBotRead } from './bot-host-per-bot-read'

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

function mount(botCount: number, scoped = true, maxIds = 500) {
  answers = Object.fromEntries(
    Array.from({ length: botCount }, (_, i) => [`bot-${i}`, `value-${i}`])
  )
  calls.splice(0)
  const reader = createBotHostPerBotRead<string, { values: Record<string, string> }>({
    method: 'bots.test',
    kinds: ['chats'],
    pick: (answer) => answer.values,
    same: (a, b) => a === b,
    ...(scoped ? { scoped: { maxIds } } : {})
  })
  const hook = renderHook(({ id }) => reader.useValue({ id, hostId: 'local' }), {
    initialProps: { id: 'bot-3' }
  })
  return hook
}

afterEach(() => {
  cleanup()
  gate = Promise.resolve()
  failNext = false
})

describe('createBotHostPerBotRead', () => {
  it.each([10, 100])('reads only the bot a notice names, of %i bots', async (botCount) => {
    const hook = mount(botCount)
    await flush()
    expect(calls).toEqual([{}])
    expect(hook.result.current).toBe('value-3')

    calls.splice(0)
    answers['bot-3'] = 'renamed'
    emitBotsChangedWindowEvent('local', { botIds: ['bot-3'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-3'] }])
    expect(hook.result.current).toBe('renamed')

    // A bot whose value is gone drops out; the others are kept.
    calls.splice(0)
    delete answers['bot-3']
    emitBotsChangedWindowEvent('local', { botIds: ['bot-3'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-3'] }])
    expect(hook.result.current).toBeUndefined()
    hook.rerender({ id: 'bot-4' })
    expect(hook.result.current).toBe('value-4')

    // A notice naming no bot reads every bot.
    calls.splice(0)
    emitBotsChangedWindowEvent('local', { kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{}])
  })

  it('joins notices heard while a read is in flight into one read after it', async () => {
    const hook = mount(10)
    await flush()
    calls.splice(0)
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    emitBotsChangedWindowEvent('local', { botIds: ['bot-1'], kinds: ['chats'] })
    emitBotsChangedWindowEvent('local', { botIds: ['bot-2'], kinds: ['chats'] })
    answers['bot-3'] = 'renamed'
    emitBotsChangedWindowEvent('local', { botIds: ['bot-3'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-1'] }])
    release()
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-1'] }, { botIds: ['bot-2', 'bot-3'] }])
    // The change heard mid-read still reaches the row.
    expect(hook.result.current).toBe('renamed')
  })

  it('reads every bot from a method that takes no names', async () => {
    mount(10, false)
    await flush()
    calls.splice(0)
    emitBotsChangedWindowEvent('local', { botIds: ['bot-3'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{}])
  })

  it('reads every bot when joined notices name more bots than one read may', async () => {
    mount(10, true, 2)
    await flush()
    calls.splice(0)
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    emitBotsChangedWindowEvent('local', { botIds: ['bot-1'], kinds: ['chats'] })
    emitBotsChangedWindowEvent('local', { botIds: ['bot-2', 'bot-3'], kinds: ['chats'] })
    emitBotsChangedWindowEvent('local', { botIds: ['bot-4'], kinds: ['chats'] })
    await flush()
    release()
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-1'] }, {}])
  })

  it('reads every bot after a failed read, so the bot it missed is not left stale', async () => {
    const hook = mount(10)
    await flush()
    calls.splice(0)
    failNext = true
    answers['bot-3'] = 'renamed'
    emitBotsChangedWindowEvent('local', { botIds: ['bot-3'], kinds: ['chats'] })
    await flush()
    expect(hook.result.current).toBe('value-3')
    emitBotsChangedWindowEvent('local', { botIds: ['bot-1'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-3'] }, {}])
    expect(hook.result.current).toBe('renamed')
    // Healed: the next notice reads only its bot again.
    calls.splice(0)
    emitBotsChangedWindowEvent('local', { botIds: ['bot-1'], kinds: ['chats'] })
    await flush()
    expect(calls).toEqual([{ botIds: ['bot-1'] }])
  })
})
