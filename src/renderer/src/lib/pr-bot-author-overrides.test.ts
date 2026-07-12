import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPRBotAuthorOverride } from '../../../shared/pr-bot-author-overrides'

const store = vi.hoisted(() => ({
  settings: { prBotAuthorOverrides: [] as string[] },
  pending: [] as (() => void)[],
  apiUpdate: vi.fn(),
  warning: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { warning: store.warning } }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => ({ settings: store.settings }),
    setState: (next: { settings: typeof store.settings }) => {
      store.settings = next.settings
    }
  })
}))

import { setPRBotAuthorOverride } from './pr-bot-author-overrides'

describe('PR bot author override updates', () => {
  beforeEach(() => {
    store.settings = { prBotAuthorOverrides: [] }
    store.pending = []
    store.apiUpdate.mockReset()
    store.warning.mockReset()
    store.apiUpdate.mockImplementation(
      (args: { author: string; isBot: boolean }) =>
        new Promise((resolve) => {
          store.pending.push(() => {
            store.settings = {
              prBotAuthorOverrides: applyPRBotAuthorOverride(
                store.settings.prBotAuthorOverrides,
                args.author,
                args.isBot
              )
            }
            resolve(store.settings)
          })
        })
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { settings: { updatePRBotAuthorOverride: store.apiUpdate } } }
    })
  })

  it('serializes rapid updates while the authoritative store merges each delta', async () => {
    setPRBotAuthorOverride('alice', true)
    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() => expect(store.apiUpdate).toHaveBeenCalledTimes(1))
    store.pending.shift()?.()
    await vi.waitFor(() => expect(store.apiUpdate).toHaveBeenCalledTimes(2))
    store.pending.shift()?.()
    await vi.waitFor(() =>
      expect(store.settings.prBotAuthorOverrides).toEqual(['alice', 'bob'])
    )
  })

  it('continues processing updates after an atomic settings write fails', async () => {
    store.apiUpdate
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce({ prBotAuthorOverrides: ['bob'] })

    setPRBotAuthorOverride('alice', true)
    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() => expect(store.apiUpdate).toHaveBeenCalledTimes(2))
    expect(store.settings.prBotAuthorOverrides).toEqual(['bob'])
  })

  it('warns without evicting an existing override when the limit is reached', async () => {
    const current = Array.from({ length: 500 }, (_, index) => `bot-${index}`)
    store.apiUpdate.mockResolvedValue({ prBotAuthorOverrides: current })

    setPRBotAuthorOverride('new-bot', true)

    await vi.waitFor(() =>
      expect(store.warning).toHaveBeenCalledWith('Bot author override limit reached')
    )
    expect(store.settings.prBotAuthorOverrides).toEqual(current)
  })
})
