import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPRBotAuthorOverride } from '../../../../../shared/source-control/review-comments/pr-bot-author-overrides'

const store = vi.hoisted(() => ({
  settings: { prBotAuthorOverrides: [] as string[] },
  pending: [] as (() => void)[],
  apiUpdate: vi.fn(),
  warning: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { warning: store.warning } }))

vi.mock('@/store/index', () => ({
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

  it('continues processing updates after an atomic settings write fails', async () => {
    store.apiUpdate
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce({ prBotAuthorOverrides: ['bob'] })

    setPRBotAuthorOverride('alice', true)
    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() => expect(store.apiUpdate).toHaveBeenCalledTimes(2))
    expect(store.settings.prBotAuthorOverrides).toEqual(['bob'])
  })
})
