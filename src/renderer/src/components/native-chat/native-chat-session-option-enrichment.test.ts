import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryHostKey
} from './native-chat-session-option-discovery'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  resolveNativeChatLaunchSessionOptions,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

const mocks = vi.hoisted(() => ({
  discoverRuntimeCommitMessageModels: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.discoverRuntimeCommitMessageModels,
  getRuntimeGitScope: vi.fn()
}))

describe('native chat session option enrichment', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    mocks.discoverRuntimeCommitMessageModels.mockReset()
  })

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
    ensureNativeChatModelEnrichment({ agent: 'gemini', hostKey: 'local', discover })
    expect(discover).not.toHaveBeenCalled()
  })

  it('keeps WSL discovery separate from the Windows host and other distros', () => {
    expect(
      resolveNativeChatModelDiscoveryHostKey(
        {} as never,
        null,
        '\\\\wsl.localhost\\Ubuntu\\home\\orca',
        null
      )
    ).toBe('wsl:Ubuntu')
    expect(
      resolveNativeChatModelDiscoveryHostKey(
        {} as never,
        null,
        '\\\\wsl.localhost\\Debian\\home\\orca',
        null
      )
    ).toBe('wsl:Debian')
    expect(resolveNativeChatModelDiscoveryHostKey({} as never, null, 'C:\\repo', null)).toBe(
      'local'
    )
  })

  it('uses only discovered Claude rows and capabilities per host', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [
        {
          id: 'opus[1m]',
          label: 'Opus (1M context)',
          description: 'Opus 5 with 1M context',
          thinkingLevels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' }
          ],
          defaultThinkingLevel: 'low',
          supportsFastMode: true
        },
        {
          id: 'sonnet',
          label: 'Sonnet',
          thinkingLevels: [{ id: 'medium', label: 'Medium' }]
        }
      ]
    })
    const discover = vi.fn(() =>
      discoverNativeChatCatalogModels('claude', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    )
    const listener = vi.fn()
    subscribeNativeChatEnrichedModels('claude', 'ssh:host', listener)

    ensureNativeChatModelEnrichment({ agent: 'claude', hostKey: 'ssh:host', discover })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())

    const models = readNativeChatEnrichedModels('claude', 'ssh:host')!
    expect(models.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet'])
    const sonnetEffort = models.find(({ id }) => id === 'sonnet')?.options[0]
    expect(sonnetEffort?.kind).toMatchObject({
      type: 'select',
      choices: [{ value: 'medium', label: 'Medium' }]
    })
    expect(models.find(({ id }) => id === 'opus[1m]')).toMatchObject({
      id: 'opus[1m]',
      description: 'Opus 5 with 1M context',
      options: [
        expect.objectContaining({
          id: 'effort',
          kind: expect.objectContaining({
            choices: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          })
        }),
        expect.objectContaining({ id: 'fastMode' })
      ]
    })
    expect(readNativeChatEnrichedModels('claude', 'local')).toBeNull()
  })

  it('carries grok’s probed default through discovery to the published rows', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [
        { id: 'grok-build', label: 'Grok Build' },
        { id: 'grok-5', label: 'Grok 5', isDefault: true }
      ]
    })
    const discover = vi.fn(() =>
      discoverNativeChatCatalogModels('grok', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    )
    const listener = vi.fn()
    subscribeNativeChatEnrichedModels('grok', 'ssh:host', listener)

    ensureNativeChatModelEnrichment({ agent: 'grok', hostKey: 'ssh:host', discover })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())

    const models = readNativeChatEnrichedModels('grok', 'ssh:host')!
    // The seed's grok-4.5 is gone (discovery is authoritative) and its default flag
    // did not survive onto a row the account no longer calls default.
    expect(models.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      ['grok-build', undefined],
      ['grok-5', true]
    ])
    // Effort is a global grok flag, so both unseeded rows still get the menu.
    expect(models.map((model) => model.options.map(({ id }) => id))).toEqual([
      ['effort'],
      ['effort']
    ])
  })

  it('publishes no default when an older host omits the flag entirely', async () => {
    // A remote Orca predating `isDefault` sends rows without it; the picker must
    // name no model rather than fall back to a seed row the account may have retired.
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'grok-4.5', label: 'Grok 4.5' }]
    })
    const discover = vi.fn(() =>
      discoverNativeChatCatalogModels('grok', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    )
    const listener = vi.fn()
    subscribeNativeChatEnrichedModels('grok', 'ssh:legacy', listener)

    ensureNativeChatModelEnrichment({ agent: 'grok', hostKey: 'ssh:legacy', discover })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())

    const published = readNativeChatEnrichedModels('grok', 'ssh:legacy')!
    expect(published.map(({ id }) => id)).toEqual(['grok-4.5'])
    expect(published[0]!.isDefault).toBeUndefined()
  })

  it('rejects a spec fallback for grok too, not just claude', async () => {
    // Grok's list replaces the seed rather than extending it, so letting a static
    // fallback through would retire real models and blank the picker.
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'spec',
      models: [{ id: 'grok-4.5', label: 'Grok 4.5' }]
    })

    await expect(
      discoverNativeChatCatalogModels('grok', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    ).resolves.toBeNull()
  })

  it('still lets a spec fallback through for an additive agent', async () => {
    // Cursor merges onto its seed, so a fallback list costs nothing and dropping it
    // would be a regression — the probe guard must stay scoped to authoritative agents.
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'spec',
      models: [{ id: 'auto', label: 'Auto' }]
    })

    await expect(
      discoverNativeChatCatalogModels('cursor', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    ).resolves.toEqual([{ id: 'auto', label: 'Auto', options: [] }])
  })

  it('uses the authoritative merge for grok and the additive one for cursor', async () => {
    // Both branches of the same ternary: deleting the authoritative arm typechecks
    // and leaves every additive-agent test passing.
    const discoverGrok = vi.fn().mockResolvedValue([{ id: 'grok-5', label: 'Grok 5', options: [] }])
    const discoverCursor = vi.fn().mockResolvedValue([{ id: 'extra', label: 'Extra', options: [] }])
    ensureNativeChatModelEnrichment({ agent: 'grok', hostKey: 'm', discover: discoverGrok })
    ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'm', discover: discoverCursor })
    await vi.waitFor(() => {
      expect(readNativeChatEnrichedModels('grok', 'm')).not.toBeNull()
      expect(readNativeChatEnrichedModels('cursor', 'm')).not.toBeNull()
    })

    expect(readNativeChatEnrichedModels('grok', 'm')!.map(({ id }) => id)).toEqual(['grok-5'])
    expect(readNativeChatEnrichedModels('cursor', 'm')!.map(({ id }) => id)).toContain('auto')
  })

  it('drops a persisted grok launch model missing from every settled probe', async () => {
    // Regression: launch sites resolved the persisted model with no discovery gate,
    // so the first launch after a probe (but before async settings retirement
    // landed) still emitted the fatal `-m <retired>`.
    const persisted = {
      grok: { model: 'grok-4.5', valuesByModel: { 'grok-4.5': { effort: 'low' } } }
    }
    // No probe data: the pick is honored — absence of data is not proof of absence.
    expect(resolveNativeChatLaunchSessionOptions(persisted, 'grok')).toMatchObject({
      model: 'grok-4.5',
      effort: 'low'
    })

    const discover = vi.fn().mockResolvedValue([{ id: 'grok-5', label: 'Grok 5', options: [] }])
    ensureNativeChatModelEnrichment({ agent: 'grok', hostKey: 'local', discover })
    await vi.waitFor(() => expect(readNativeChatEnrichedModels('grok', 'local')).not.toBeNull())

    expect(resolveNativeChatLaunchSessionOptions(persisted, 'grok')).toBeUndefined()
    // A model any settled host still lists keeps resolving.
    expect(resolveNativeChatLaunchSessionOptions({ grok: { model: 'grok-5' } }, 'grok')).toEqual({
      model: 'grok-5'
    })
    // Non-authoritative agents are untouched by the gate.
    expect(
      resolveNativeChatLaunchSessionOptions({ claude: { model: 'retired' } }, 'claude')
    ).toEqual({ model: 'retired' })
  })

  it('does not advertise the Claude spec fallback when probing is unavailable', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'spec',
      models: [{ id: 'sonnet', label: 'Sonnet' }]
    })

    await expect(
      discoverNativeChatCatalogModels('claude', {
        settings: {},
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    ).resolves.toBeNull()
  })
})
