import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeDiscoveredAuthoritativeModels } from '../../../../shared/agent-session-option-catalog'
import { GROK_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-grok'
import { updateNativeChatSessionOptionDefaults } from '../../../../shared/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import {
  createNativeChatPtySessionOptions,
  type CreateNativeChatPtySessionOptionsArgs,
  type NativeChatPtySessionOptionsSurface
} from './native-chat-pty-session-options'

const discoveredGrok5 = (): ReturnType<typeof mergeDiscoveredAuthoritativeModels> =>
  mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
    { id: 'grok-5', label: 'Grok 5', isDefault: true, options: [] }
  ])

function createGrokSurface(args?: Partial<CreateNativeChatPtySessionOptionsArgs>): {
  surface: NativeChatPtySessionOptionsSurface
  persisted: () => PersistedNativeChatSessionOptions
} {
  let persisted: PersistedNativeChatSessionOptions = {}
  const surface = createNativeChatPtySessionOptions({
    agent: 'grok',
    scopeKey: 'pty-1',
    mode: 'live',
    dispatchCommand: vi.fn(),
    persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) => {
      persisted = updateNativeChatSessionOptionDefaults({
        persisted,
        agent: 'grok',
        modelId,
        optionId,
        value,
        adoptModelAsLaunchDefault
      })
    },
    ...args
  })!
  return { surface, persisted: () => persisted }
}

/** Retirement clears settings, but the session-tracked model is what option writes
 *  re-persist — left tracked, a retired id re-enters the picker via re-injection and
 *  restores the fatal `-m <retired>` the retirement just removed. */
describe('retired grok model untracking', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('untracks a picked model an authoritative discovery dropped', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5' })
    const { surface, persisted } = createGrokSurface()

    surface.replaceModels(discoveredGrok5())

    // The retired id is gone from the picker, not kept as a reconciled row.
    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'grok-5',
      choices: [expect.objectContaining({ value: 'grok-5' })]
    })
    expect(readNativeChatSessionOptionCache('pty-1')?.model).toBeUndefined()

    // A later option write persists under the surviving default, never the retired id.
    await surface.setOption('effort', 'low')
    expect(persisted().grok?.model).toBe('grok-5')
  })

  it('untracks a cached retired model at surface creation', () => {
    // The probe can settle before this pane mounts; the cache handoff then restores a
    // tracked id the authoritative list already dropped.
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5' })
    const { surface } = createGrokSurface({ initialModels: discoveredGrok5() })

    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'grok-5',
      choices: [expect.objectContaining({ value: 'grok-5' })]
    })
    expect(readNativeChatSessionOptionCache('pty-1')?.model).toBeUndefined()
  })

  it('never persists a typed model the authoritative list lacks', () => {
    // `/model <retired>` is tracked for display, but adopting it as the persisted
    // launch default would recreate the fatal `-m` retirement just cleared.
    const { surface, persisted } = createGrokSurface({ initialModels: discoveredGrok5() })

    surface.recordOutgoingCommand('/model grok-4.5')

    expect(persisted().grok?.model).toBeUndefined()
    // A typed id the list does carry still persists as before.
    surface.recordOutgoingCommand('/model grok-5')
    expect(persisted().grok?.model).toBe('grok-5')
  })
})
