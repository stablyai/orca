import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX,
  NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

describe('native chat session option enrichment', () => {
  beforeEach(() => clearNativeChatModelEnrichmentForTests())

  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve()
    }
  }

  it('keeps reads synchronous while one host-scoped probe is in flight', async () => {
    let resolveDiscovery: ((models: CatalogModel[]) => void) | undefined
    const discover = vi.fn(
      () =>
        new Promise<CatalogModel[]>((resolve) => {
          resolveDiscovery = resolve
        })
    )
    const listener = vi.fn()
    subscribeNativeChatEnrichedModels('cursor', 'ssh:one', listener)

    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:one', discover })
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:one', discover })

    expect(readNativeChatEnrichedModels('cursor', 'ssh:one')).toBeNull()
    expect(discover).toHaveBeenCalledOnce()

    resolveDiscovery?.([
      { id: 'gpt-5.3-codex', label: 'GPT 5.3 live', options: [] },
      { id: 'account-model', label: 'Account model', options: [] }
    ])
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())

    const models = readNativeChatEnrichedModels('cursor', 'ssh:one')!
    expect(models.find((model) => model.id === 'gpt-5.3-codex')).toMatchObject({
      label: 'GPT 5.3 live',
      options: expect.arrayContaining([expect.objectContaining({ id: 'effort' })])
    })
    expect(models.at(-1)).toMatchObject({ id: 'account-model' })
    expect(readNativeChatEnrichedModels('cursor', 'ssh:two')).toBeNull()
  })

  it('falls back permanently to the seed after a failed once-per-host probe', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('offline'))
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())
    await Promise.resolve()

    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
    expect(discover).toHaveBeenCalledOnce()
    expect(readNativeChatEnrichedModels('cursor', 'local')).toBeNull()
  })

  it('does not probe agents whose catalogs have no discovery command', () => {
    const discover = vi.fn()
    ensureNativeChatModelEnrichment({ agent: 'claude', hostKey: 'local', discover })
    expect(discover).not.toHaveBeenCalled()
  })

  it('evicts old host model arrays instead of retaining every host for the renderer lifetime', async () => {
    for (let index = 0; index <= NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX; index += 1) {
      ensureNativeChatModelEnrichment({
        agent: 'cursor',
        hostKey: `ssh:${index}`,
        discover: async () => [{ id: `host-model-${index}`, label: `Host ${index}`, options: [] }]
      })
      await flushMicrotasks()
    }

    expect(readNativeChatEnrichedModels('cursor', 'ssh:0')).toBeNull()
    expect(
      readNativeChatEnrichedModels('cursor', `ssh:${NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX}`)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `host-model-${NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX}` })
      ])
    )
  })

  it('bounds hung host discovery promises without building a hidden probe queue', async () => {
    const resolvers: ((models: CatalogModel[]) => void)[] = []
    const discovers = Array.from({ length: NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX + 1 }, () =>
      vi.fn(
        () =>
          new Promise<CatalogModel[]>((resolve) => {
            resolvers.push(resolve)
          })
      )
    )

    for (const [index, discover] of discovers.entries()) {
      ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: `hung:${index}`, discover })
    }
    await flushMicrotasks()
    expect(
      discovers
        .slice(0, NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX)
        .every((probe) => probe.mock.calls.length === 1)
    ).toBe(true)
    expect(discovers.at(-1)).not.toHaveBeenCalled()

    resolvers[0]?.([{ id: 'released', label: 'Released', options: [] }])
    await flushMicrotasks()
    ensureNativeChatModelEnrichment({
      agent: 'cursor',
      hostKey: `hung:${NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX}`,
      discover: discovers.at(-1)!
    })
    await flushMicrotasks()
    expect(discovers.at(-1)).toHaveBeenCalledOnce()
    for (const resolve of resolvers) {
      resolve([])
    }
    await flushMicrotasks()
  })
})
