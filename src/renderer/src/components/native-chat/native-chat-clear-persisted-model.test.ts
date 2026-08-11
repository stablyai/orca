// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat-session-options'

const mocks = vi.hoisted(() => ({
  storeState: {
    settings: {} as { nativeChatSessionOptions?: PersistedNativeChatSessionOptions },
    updateSettings: vi.fn()
  },
  createNativeChatPtySessionOptions: vi.fn(),
  discoverNativeChatCatalogModels: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.storeState } }))

vi.mock('./native-chat-pty-session-options', () => ({
  createNativeChatPtySessionOptions: mocks.createNativeChatPtySessionOptions
}))

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'local', runtime: {} }),
  discoverNativeChatCatalogModels: mocks.discoverNativeChatCatalogModels
}))

const { clearPersistedNativeChatModel } = await import('./use-native-chat-session-options')

function persist(options: PersistedNativeChatSessionOptions): void {
  mocks.storeState.settings = { nativeChatSessionOptions: options }
}

/** The "Use CLI default" picker row: deleting the persisted model must restore
 *  launches that inherit the agent CLI's own configured default (#13794). */
describe('clearPersistedNativeChatModel', () => {
  beforeEach(() => {
    mocks.storeState.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.storeState.settings = {}
  })

  it('drops only the model, keeping per-model values for a later reselect', async () => {
    persist({ claude: { model: 'haiku', valuesByModel: { haiku: { effort: 'high' } } } })
    await clearPersistedNativeChatModel('claude')
    expect(mocks.storeState.updateSettings).toHaveBeenCalledWith({
      nativeChatSessionOptions: { claude: { valuesByModel: { haiku: { effort: 'high' } } } }
    })
  })

  it('clears only the named agent, leaving other agents’ picks intact', async () => {
    persist({ claude: { model: 'haiku' }, codex: { model: 'gpt-5.5-codex' } })
    await clearPersistedNativeChatModel('claude')
    expect(mocks.storeState.updateSettings).toHaveBeenCalledWith({
      nativeChatSessionOptions: { claude: {}, codex: { model: 'gpt-5.5-codex' } }
    })
  })

  it('writes nothing when no model is persisted', async () => {
    persist({ claude: { valuesByModel: { haiku: { effort: 'high' } } } })
    await clearPersistedNativeChatModel('claude')
    expect(mocks.storeState.updateSettings).not.toHaveBeenCalled()
  })

  it('survives settings that were never written', async () => {
    await expect(clearPersistedNativeChatModel('claude')).resolves.toBeUndefined()
    expect(mocks.storeState.updateSettings).not.toHaveBeenCalled()
  })

  it('re-reads live settings at apply so a clear landing after another write is not stale', async () => {
    persist({ claude: { model: 'haiku' } })
    const pending = clearPersistedNativeChatModel('claude')
    persist({})
    await pending
    expect(mocks.storeState.updateSettings).not.toHaveBeenCalled()
  })
})
