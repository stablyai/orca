import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  settings: { prBotAuthorOverrides: [] as string[] } as { prBotAuthorOverrides: string[] } | null,
  pending: [] as (() => void)[],
  updateSettings: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => ({ settings: store.settings, updateSettings: store.updateSettings })
  })
}))

import { setPRBotAuthorOverride } from './pr-bot-author-overrides'

describe('PR bot author override updates', () => {
  beforeEach(() => {
    store.settings = { prBotAuthorOverrides: [] }
    store.pending = []
    store.updateSettings.mockReset()
    store.updateSettings.mockImplementation(
      (updates: { prBotAuthorOverrides: string[] }) =>
        new Promise<void>((resolve) => {
          store.pending.push(() => {
            store.settings = { ...store.settings!, ...updates }
            resolve()
          })
        })
    )
  })

  it('serializes rapid marks so later writes include earlier authors', async () => {
    setPRBotAuthorOverride('alice', true)
    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() => expect(store.updateSettings).toHaveBeenCalledTimes(1))
    expect(store.updateSettings).toHaveBeenLastCalledWith({ prBotAuthorOverrides: ['alice'] })

    store.pending.shift()?.()
    await vi.waitFor(() => expect(store.updateSettings).toHaveBeenCalledTimes(2))
    expect(store.updateSettings).toHaveBeenLastCalledWith({
      prBotAuthorOverrides: ['alice', 'bob']
    })
    store.pending.shift()?.()
  })

  it('continues processing updates after a settings write fails', async () => {
    store.updateSettings
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockImplementationOnce(async (updates: { prBotAuthorOverrides: string[] }) => {
        store.settings = { ...store.settings!, ...updates }
      })

    setPRBotAuthorOverride('alice', true)
    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() => expect(store.updateSettings).toHaveBeenCalledTimes(2))
    expect(store.updateSettings).toHaveBeenLastCalledWith({ prBotAuthorOverrides: ['bob'] })
  })
})
