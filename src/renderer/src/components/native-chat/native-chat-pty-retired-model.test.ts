import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeDiscoveredAuthoritativeModels } from '../../../../shared/agent-session-option-catalog'
import { GROK_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-grok'
import {
  applyNativeChatSessionOptionSettingsMutation,
  updateNativeChatSessionOptionDefaults
} from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import {
  createNativeChatPtySessionOptions,
  type CreateNativeChatPtySessionOptionsArgs,
  type NativeChatPtySessionOptionsSurface
} from '../../../../shared/native-chat-pty-session-options'

const discoveredGrok5 = (): ReturnType<typeof mergeDiscoveredAuthoritativeModels> =>
  mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
    { id: 'grok-5', label: 'Grok 5', isDefault: true, options: [] }
  ])

function createGrokSurface(
  args?: Partial<CreateNativeChatPtySessionOptionsArgs>,
  initial: PersistedNativeChatSessionOptions = {}
): {
  surface: NativeChatPtySessionOptionsSurface
  persisted: () => PersistedNativeChatSessionOptions
  applyLegacyCatalogClear: () => void
} {
  let persisted = initial
  const surface = createNativeChatPtySessionOptions({
    agent: 'grok',
    scopeKey: 'pty-1',
    mode: 'live',
    modelLabel: 'Model',
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
  return {
    surface,
    persisted: () => persisted,
    applyLegacyCatalogClear: () => {
      persisted =
        applyNativeChatSessionOptionSettingsMutation(persisted, {
          type: 'clear-model-if-missing',
          agent: 'grok',
          availableModelIds: ['grok-5']
        }) ?? persisted
    }
  }
}

describe('current model retention beside future launch defaults', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('retains current and saved models through legacy catalog clearing and a later effort pick', async () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5' })
    const { surface, persisted, applyLegacyCatalogClear } = createGrokSurface(undefined, {
      grok: { model: 'grok-4.5', valuesByModel: {} }
    })

    surface.replaceModels(discoveredGrok5())
    applyLegacyCatalogClear()
    expect(persisted().grok?.model).toBe('grok-4.5')

    // Discovery does not replace the current session selection.
    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'grok-4.5',
      choices: expect.arrayContaining([expect.objectContaining({ value: 'grok-4.5' })])
    })
    expect(readNativeChatSessionOptionCache('pty-1')?.model?.value).toBe('grok-4.5')

    // A later effort write preserves the saved model and updates its scoped option.
    await surface.setOption('effort', 'low')
    expect(persisted().grok?.model).toBe('grok-4.5')
    expect(persisted().grok?.valuesByModel?.['grok-4.5']?.effort).toBe('low')
  })

  it('retains a cached model omitted before surface creation', () => {
    // The probe can settle before this pane mounts; the cache handoff then restores a
    // tracked id the authoritative list already dropped.
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5' })
    const { surface } = createGrokSurface({ initialModels: discoveredGrok5() })

    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'grok-4.5',
      choices: expect.arrayContaining([expect.objectContaining({ value: 'grok-4.5' })])
    })
    expect(readNativeChatSessionOptionCache('pty-1')?.model?.value).toBe('grok-4.5')
  })

  it('never persists a typed model the authoritative list lacks', () => {
    // Typed retired ids may display but must not recreate a fatal launch default.
    const { surface, persisted } = createGrokSurface({ initialModels: discoveredGrok5() })

    surface.recordOutgoingCommand('/model grok-4.5')

    expect(persisted().grok?.model).toBeUndefined()
    surface.recordOutgoingCommand('/model grok-5')
    expect(persisted().grok?.model).toBe('grok-5')
  })
})
