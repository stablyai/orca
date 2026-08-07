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
