// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import { botTarget, callBotRpc, forEachBotHost } from './bot-hosts'
import { emitBotsChangedWindowEvent, onBotsChanged } from './bots-changed-window-event'

afterEach(() => {
  mocks.callRuntimeRpc.mockReset()
})

describe('botTarget', () => {
  it('hands out one target per host, so hooks keyed on it never resubscribe', () => {
    expect(botTarget({ hostId: 'runtime:env-1' })).toBe(botTarget({ hostId: 'runtime:env-1' }))
  })

  it('refuses a host no bot can run on', () => {
    expect(() => botTarget({ hostId: 'ssh:box' })).toThrow()
  })
})

describe('callBotRpc', () => {
  it('calls the bot’s own host, not this computer', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ activity: null })
    const bot = { hostId: 'runtime:env-2', id: 'b1' } as const
    await callBotRpc(bot, 'bots.activity', { botId: 'b1' })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-2' },
      'bots.activity',
      { botId: 'b1' }
    )
  })
})

describe('forEachBotHost', () => {
  it('runs on every listed host', async () => {
    const answers = await forEachBotHost(({ hostId, target }) => ({ hostId, target }))
    expect(answers.map(({ value }) => value)).toEqual([
      { hostId: 'local', target: { kind: 'local' } }
    ])
  })

  it('leaves out a host that fails instead of failing the rest', async () => {
    await expect(forEachBotHost(() => Promise.reject(new Error('unreachable')))).resolves.toEqual(
      []
    )
  })
})

describe('the bots-changed window event', () => {
  it('names the host that changed, and a host-scoped reader hears only its host', () => {
    const anyHost = vi.fn()
    const server = vi.fn()
    const stopAny = onBotsChanged(anyHost)
    const stopServer = onBotsChanged(server, 'runtime:env-1')

    emitBotsChangedWindowEvent('local')
    emitBotsChangedWindowEvent('runtime:env-1')
    stopAny()
    stopServer()
    emitBotsChangedWindowEvent('runtime:env-1')

    expect(anyHost.mock.calls).toEqual([
      ['local', undefined],
      ['runtime:env-1', undefined]
    ])
    expect(server.mock.calls).toEqual([['runtime:env-1', undefined]])
  })
})
