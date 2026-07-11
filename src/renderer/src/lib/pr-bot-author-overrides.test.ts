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
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          settings: {
            get: vi.fn(async () => store.settings)
          }
        }
      }
    })
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

  it('merges against canonical settings instead of a stale renderer snapshot', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      prBotAuthorOverrides: ['alice']
    } as Awaited<ReturnType<typeof window.api.settings.get>>)
    store.updateSettings.mockResolvedValue(undefined)

    setPRBotAuthorOverride('bob', true)

    await vi.waitFor(() =>
      expect(store.updateSettings).toHaveBeenCalledWith({
        prBotAuthorOverrides: ['alice', 'bob']
      })
    )
  })

  it('does not evict an existing override when the limit is reached', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      prBotAuthorOverrides: Array.from({ length: 500 }, (_, index) => `bot-${index}`)
    } as Awaited<ReturnType<typeof window.api.settings.get>>)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    setPRBotAuthorOverride('new-bot', true)

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('PR bot author override limit reached'))
    expect(store.updateSettings).not.toHaveBeenCalled()
  })
})
