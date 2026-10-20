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

describe('grok inventory and session selection', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it.each([false, true])('keeps a live model omitted by discovery (cached: %s)', async (cached) => {
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5', effort: 'high' })
    const tracked = readNativeChatSessionOptionCache('pty-1')
    if (tracked === null) {
      throw new Error('Expected the seeded session option cache')
    }
    const { surface, persisted } = createGrokSurface({
      initialModels: cached ? discoveredGrok5() : undefined
    })

    surface.replaceModels(discoveredGrok5())

    expect(surface.getSnapshot()[0].kind).toMatchObject({
      currentValue: 'grok-4.5',
      choices: ['grok-5', 'grok-4.5'].map((value) => expect.objectContaining({ value }))
    })
    expect(readNativeChatSessionOptionCache('pty-1')).toMatchObject(tracked)

    await surface.setOption('model', 'grok-4.5')
    await surface.setOption('effort', 'low')
    expect(persisted().grok?.model).toBeUndefined()
  })

  it('retires an omitted draft model at surface creation', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'grok', { model: 'grok-4.5' })
    const { surface } = createGrokSurface({ mode: 'draft', initialModels: discoveredGrok5() })

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
