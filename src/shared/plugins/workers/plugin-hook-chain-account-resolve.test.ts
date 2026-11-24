import { describe, expect, it, vi } from 'vitest'
import { runPluginHookChain } from './plugin-hook-chain'

const payload = { agent: 'claude', workspaceId: 'ws-1', botId: 'bot-1', account: 'work' }

function chain(invoke: (key: string, payload: unknown, timeoutMs: number) => Promise<unknown>) {
  return runPluginHookChain({
    event: 'agent.account.resolve',
    payload,
    participants: ['pool'],
    invoke,
    log: () => {},
    now: () => 0,
    deadlineMs: 20
  })
}

describe('agent.account.resolve hook', () => {
  it('lets a plugin change only the account', async () => {
    const outcome = await chain(async () => ({
      decision: 'continue',
      payload: { ...payload, account: 'home', botId: 'someone-else' }
    }))
    expect(outcome).toEqual({ kind: 'continue', payload: { ...payload, account: 'home' } })
  })

  it('carries on with the saved account when the plugin outlasts the deadline', async () => {
    vi.useFakeTimers()
    try {
      const pending = chain(() => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(25)
      expect(await pending).toEqual({ kind: 'continue', payload })
    } finally {
      vi.useRealTimers()
    }
  })
})
