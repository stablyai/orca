import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseGrokModelList } from '../../../../shared/grok-model-list-probe'
import { parseClaudeModels } from '../../../../shared/commit-message-model-parsers'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { readNativeChatSessionOptionCache } from './native-chat-session-option-cache'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryHostKey
} from './native-chat-session-option-discovery'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  getNativeChatModelEnrichmentEntryCountForTests,
  NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES,
  NATIVE_CHAT_MODEL_LIST_STALE_MS,
  readNativeChatEnrichedModels,
  resolveNativeChatLaunchSessionOptions,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

const mocks = vi.hoisted(() => ({
  discoverRuntimeCommitMessageModels: vi.fn(),
  callStructuredAgentSession: vi.fn()
}))

vi.mock('@/runtime/runtime-git-generation-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.discoverRuntimeCommitMessageModels
}))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

describe('native chat session option enrichment', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    mocks.discoverRuntimeCommitMessageModels.mockReset()
    mocks.callStructuredAgentSession.mockReset().mockResolvedValue({
      origin: 'live-session',
      models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
      fetchedAt: 1
    })
  })

  it('reads the host catalog only for a pane on this machine', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'gpt-cli', label: 'GPT CLI' }]
    })
    const context = {
      target: { kind: 'local' as const },
      worktreeId: 'repo::/worktree',
      worktreePath: '/worktree'
    }

    const local = await discoverNativeChatCatalogModels('codex', context, 'local')
    expect(local?.map(({ id }) => id)).toEqual(['gpt-host'])
    expect(mocks.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()

    // A paired runtime's key also covers its SSH and WSL worktrees, which its
    // native store cannot speak for; the worktree-scoped CLI listing answers.
    mocks.callStructuredAgentSession.mockClear()
    const paired = await discoverNativeChatCatalogModels('codex', context, 'runtime:env-1')
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
    expect(paired?.map(({ id }) => id)).toContain('gpt-cli')
  })

  it('lists through the CLI when this machine runs a custom launch command', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'gpt-custom', label: 'GPT Custom' }]
    })
    const context = {
      target: { kind: 'local' as const },
      prefs: { agentCmdOverrides: { codex: 'codex-nightly' } },
      worktreeId: 'repo::/worktree',
      worktreePath: '/worktree'
    }

    // The structured catalog lists the built-in binary, which this terminal does not run.
    const models = await discoverNativeChatCatalogModels('codex', context, 'local')
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
    expect(models?.map(({ id }) => id)).toContain('gpt-custom')
  })

  it('bounds settled host enrichment entries', async () => {
    for (let index = 0; index < NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES + 4; index += 1) {
      ensureNativeChatModelEnrichment({
        agent: 'cursor',
        hostKey: `ssh:${index}`,
        discover: async () => []
      })
    }
    await Promise.resolve()
    await Promise.resolve()

    expect(getNativeChatModelEnrichmentEntryCountForTests()).toBe(
      NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES
    )
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

  it('asks again once the list is stale, keeping the last good list through a failure', async () => {
    vi.useFakeTimers()
    try {
      const first = [{ id: 'model-a', label: 'A', options: [] }]
      const discover = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce([...first, { id: 'model-b', label: 'B', options: [] }])
      const listener = vi.fn()
      subscribeNativeChatEnrichedModels('cursor', 'local', listener)
      const ensureAfter = async (ms: number): Promise<void> => {
        vi.advanceTimersByTime(ms)
        ensureNativeChatModelEnrichment({ agent: 'cursor', hostKey: 'local', discover })
        await vi.runAllTimersAsync()
      }
      const ids = (): string[] | undefined =>
        readNativeChatEnrichedModels('cursor', 'local')?.map(({ id }) => id)

      await ensureAfter(0)
      await ensureAfter(1)
      expect(discover).toHaveBeenCalledOnce()
      // A failed probe is retried, not latched; a fresh success is not re-asked.
      await ensureAfter(NATIVE_CHAT_MODEL_LIST_STALE_MS)
      await ensureAfter(1)
      expect(discover).toHaveBeenCalledTimes(2)
      await ensureAfter(NATIVE_CHAT_MODEL_LIST_STALE_MS)
      expect(ids()).toContain('model-a')
      await ensureAfter(NATIVE_CHAT_MODEL_LIST_STALE_MS)
      expect(listener).toHaveBeenCalledOnce()
      await ensureAfter(NATIVE_CHAT_MODEL_LIST_STALE_MS)
      expect(ids()).toContain('model-b')
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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

  it('carries the context window OMP lists for each model, absent from an older host', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [
        {
          id: 'openai-codex/gpt-5.5',
          label: 'GPT-5.5',
          description: 'openai-codex',
          contextWindowTokens: 272_000
        },
        { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4', description: 'openai-codex' }
      ]
    })
    const models = await discoverNativeChatCatalogModels('omp', {
      target: { kind: 'local' as const },
      worktreeId: 'repo::/worktree',
      worktreePath: '/worktree'
    })
    expect(models).toEqual([
      {
        id: 'openai-codex/gpt-5.5',
        label: 'GPT-5.5',
        description: 'openai-codex',
        contextWindowTokens: 272_000,
        options: []
      },
      { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4', description: 'openai-codex', options: [] }
    ])
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
        target: { kind: 'local' as const },
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
    const liveArgs = {
      agent: 'claude' as const,
      scopeKey: 'claude-definitions',
      mode: 'live' as const,
      initialModels: models,
      reportedValues: { model: 'opus[1m]', effort: 'low' },
      dispatchCommand: vi.fn()
    }
    const live = createNativeChatPtySessionOptions(liveArgs)!
    const probe = async (json: string) => {
      mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
        success: true,
        catalogOrigin: 'probe',
        models: parseClaudeModels(json)
      })
      return (await discover())!
    }
    const withdrawn = await probe(
      '{"type":"control_response","response":{"subtype":"success","response":{"models":[{"value":"opus[1m]","supportsEffort":false}]}}}'
    )
    live.replaceModels(withdrawn)
    expect(withdrawn[0].options).toEqual([])
    expect(live.getSnapshot().find(({ id }) => id === 'effort')?.kind).toMatchObject({
      choices: [{ value: 'low' }, { value: 'high' }]
    })
    const fresh = createNativeChatPtySessionOptions({
      ...liveArgs,
      scopeKey: 'fresh',
      initialModels: withdrawn
    })!
    expect(fresh.getSnapshot().map(({ id }) => id)).toEqual(['model'])
    live.replaceModels(
      await probe(
        '{"type":"control_response","response":{"subtype":"success","response":{"models":[{"value":"opus[1m]","supportsEffort":true,"supportedEffortLevels":["medium","high"]}]}}}'
      )
    )
    expect(live.getSnapshot().find(({ id }) => id === 'effort')?.kind).toMatchObject({
      choices: [{ value: 'medium' }, { value: 'high' }, { value: 'low' }]
    })
  })

  it('carries grok’s probed default through discovery to the published rows', async () => {
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: parseGrokModelList('Available models:\n - grok-build\n * grok-5 (default)')
    })
    const discover = vi.fn(() =>
      discoverNativeChatCatalogModels('grok', {
        target: { kind: 'local' as const },
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    )
    const dispatchCommand = vi.fn()
    const persistSelection = vi.fn()
    const create = (scopeKey = 'grok-default', fallbackScopeKey?: string) =>
      createNativeChatPtySessionOptions({
        agent: 'grok',
        scopeKey,
        fallbackScopeKey,
        mode: 'live',
        dispatchCommand,
        persistSelection,
        initialModels: readNativeChatEnrichedModels('grok', 'ssh:host') ?? undefined
      })!
    const surface = create()
    const listener = vi.fn((rows: CatalogModel[]) => surface.replaceModels(rows))
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
    await surface.setOption('effort', 'low')
    const explicit = create('grok-explicit')
    await explicit.setOption('model', 'grok-build')
    await explicit.setOption('effort', 'low')
    subscribeNativeChatEnrichedModels('grok', 'ssh:host', (rows) => explicit.replaceModels(rows))
    dispatchCommand.mockClear()
    mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: parseGrokModelList('Available models:\n * grok-next (default)\n - grok-new')
    })
    const staleAt = Date.now() + NATIVE_CHAT_MODEL_LIST_STALE_MS
    const clock = vi.spyOn(Date, 'now').mockReturnValue(staleAt)
    ensureNativeChatModelEnrichment({ agent: 'grok', hostKey: 'ssh:host', discover })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    clock.mockRestore()
    expect(dispatchCommand).not.toHaveBeenCalled()
    for (const current of [surface, create(), create('handoff', 'grok-default')]) {
      expect(current.getSnapshot()).toMatchObject([
        { id: 'model', valueSource: 'default', kind: { currentValue: 'grok-5' } },
        { id: 'effort', kind: { currentValue: 'low' } }
      ])
    }
    expect(create('new-grok').getSnapshot()[0].kind).toMatchObject({ currentValue: 'grok-next' })
    expect(readNativeChatSessionOptionCache('grok-default')?.model).toBeUndefined()
    for (const current of [explicit, create('grok-explicit'), create('copy', 'grok-explicit')]) {
      expect(current.getSnapshot()[0].kind).toMatchObject({ currentValue: 'grok-build' })
      expect(current.getSnapshot().find(({ id }) => id === 'effort')?.kind).toMatchObject({
        currentValue: 'low',
        choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }]
      })
    }
    for (const [current, modelId] of [
      [surface, 'grok-5'],
      [explicit, 'grok-build']
    ] as const) {
      await current.setOption('effort', 'high')
      current.recordOutgoingCommand('/effort medium')
      expect(current.getSnapshot().find(({ id }) => id === 'effort')?.kind).toMatchObject({
        currentValue: 'medium'
      })
      expect(persistSelection.mock.lastCall?.[0]).toMatchObject({
        modelId,
        adoptModelAsLaunchDefault: false
      })
    }
    surface.reportSessionOptions({ model: 'grok-next' })
    expect(create().getSnapshot()[0]).toMatchObject({ valueSource: 'reported' })
    dispatchCommand.mockResolvedValue({ outcome: 'unknown' })
    await expect(surface.setOption('model', 'grok-build')).rejects.toThrow('Could not verify')
    surface.replaceModels(readNativeChatEnrichedModels('grok', 'ssh:host')!)
    expect(create().getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
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
        target: { kind: 'local' as const },
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
        target: { kind: 'local' as const },
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
        target: { kind: 'local' as const },
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
        target: { kind: 'local' as const },
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree'
      })
    ).resolves.toBeNull()
  })
})
