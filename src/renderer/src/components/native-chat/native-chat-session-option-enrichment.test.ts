import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { codexCatalogModelFromCapability } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

describe('native chat session option enrichment', () => {
  beforeEach(() => clearNativeChatModelEnrichmentForTests())

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

  it('retries a later surface after a transient rejected probe', async () => {
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ id: 'account-model', label: 'Account model', options: [] }])
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())

    await vi.waitFor(() => {
      ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
      expect(discover).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() =>
      expect(readNativeChatEnrichedModels('cursor', 'local')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'account-model' })])
      )
    )
  })

  it('retries a later surface after a transient empty probe', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ id: 'account-model', label: 'Account model', options: [] }])

    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())
    await vi.waitFor(() => {
      ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
      expect(discover).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => expect(readNativeChatEnrichedModels('cursor', 'local')).not.toBeNull())
  })

  it('keeps Codex Fast capabilities isolated by host', async () => {
    const fastModel = codexCatalogModelFromCapability({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      serviceTiers: [{ id: 'priority', label: 'Fast' }]
    })
    const standardModel = codexCatalogModelFromCapability({
      id: 'gpt-5.5',
      label: 'GPT-5.5'
    })

    ensureNativeChatModelEnrichment({
      agent: 'codex',
      hostKey: 'ssh:fast',
      discover: async () => [fastModel]
    })
    ensureNativeChatModelEnrichment({
      agent: 'codex',
      hostKey: 'ssh:standard',
      discover: async () => [standardModel]
    })

    await vi.waitFor(() => expect(readNativeChatEnrichedModels('codex', 'ssh:fast')).not.toBeNull())
    await vi.waitFor(() =>
      expect(readNativeChatEnrichedModels('codex', 'ssh:standard')).not.toBeNull()
    )
    expect(
      readNativeChatEnrichedModels('codex', 'ssh:fast')
        ?.find(({ id }) => id === 'gpt-5.5')
        ?.options.map(({ id }) => id)
    ).toContain('fastMode')
    expect(
      readNativeChatEnrichedModels('codex', 'ssh:standard')
        ?.find(({ id }) => id === 'gpt-5.5')
        ?.options.map(({ id }) => id)
    ).not.toContain('fastMode')
  })

  it('does not probe agents whose catalogs have no discovery command', () => {
    const discover = vi.fn()
    ensureNativeChatModelEnrichment({ agent: 'claude', hostKey: 'local', discover })
    expect(discover).not.toHaveBeenCalled()
  })

  it('backs off after consecutive discovery failures instead of retrying immediately', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('host down'))

    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:broken', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())

    // Why: the first failure should schedule a backoff, so an immediate second
    // call must not fire discovery again.
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:broken', discover })
    expect(discover).toHaveBeenCalledOnce()
  })

  it('retries after the backoff window elapses', async () => {
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error('flap'))
      .mockResolvedValueOnce([{ id: 'account-model', label: 'Account model', options: [] }])

    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:flap', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce())

    // Why: advance fake timers past the backoff so the next call retries.
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(500)
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'ssh:flap', discover })
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2))
    vi.useRealTimers()

    await vi.waitFor(() =>
      expect(readNativeChatEnrichedModels('cursor', 'ssh:flap')).not.toBeNull()
    )
  })
})
