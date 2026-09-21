// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  createNativeChatPtySessionOptions: vi.fn(),
  discoverNativeChatCatalogModels: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('./native-chat-pty-session-options', () => ({
  createNativeChatPtySessionOptions: mocks.createNativeChatPtySessionOptions
}))

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'local', runtime: {} }),
  discoverNativeChatCatalogModels: mocks.discoverNativeChatCatalogModels
}))

const { retirePersistedModelMissingFromDiscovery, useNativeChatSessionOptions } =
  await import('./use-native-chat-session-options')

const models = (...ids: string[]): CatalogModel[] =>
  ids.map((id) => ({ id, label: id, options: [] }))

const LOCAL_TARGET = { kind: 'local' } as const

/** The persisted model becomes `-m <id>` at every launch site, including ones that
 *  never render the picker, and grok exits fatally on an id it no longer lists. */
describe('retirePersistedModelMissingFromDiscovery', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
  })

  it('clears a persisted id the authoritative probe no longer lists', async () => {
    await retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      LOCAL_TARGET,
      'settings.mutateNativeChatSessionOptions',
      {
        type: 'clear-model-if-missing',
        agent: 'grok',
        availableModelIds: ['grok-4.5']
      }
    )
  })

  it('lets the host keep a concurrently selected model from the available list', async () => {
    await retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5', 'grok-build'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      LOCAL_TARGET,
      'settings.mutateNativeChatSessionOptions',
      {
        type: 'clear-model-if-missing',
        agent: 'grok',
        availableModelIds: ['grok-4.5', 'grok-build']
      }
    )
  })

  it('treats an empty list as a failed probe, not an empty account', async () => {
    await retirePersistedModelMissingFromDiscovery('grok', [])
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('leaves additive agents alone, whose lists extend the seed rather than replace it', async () => {
    await retirePersistedModelMissingFromDiscovery('cursor', models('auto'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does not depend on a client-local settings snapshot', async () => {
    await expect(
      retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'))
    ).resolves.toBeUndefined()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })

  it('swallows a failed best-effort retirement write', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime offline'))
    await expect(
      retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'))
    ).resolves.toBeUndefined()
  })
})

/** The enrichment subscription never replays, so a pane that mounts after the
 *  once-per-host probe settled would otherwise never reach retirement. */
describe('useNativeChatSessionOptions retirement on mount', () => {
  const mountPane = (): void => {
    renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'grok',
        terminalTabId: 'tab-1',
        targetPtyId: 'pty-1',
        dispatchCommand: () => undefined
      })
    )
  }

  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    mocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
    mocks.discoverNativeChatCatalogModels.mockReset().mockResolvedValue(null)
    // A stable snapshot reference: useSyncExternalStore re-renders forever otherwise.
    const emptySnapshot: never[] = []
    mocks.createNativeChatPtySessionOptions.mockReset().mockImplementation(() => ({
      subscribe: () => () => {},
      getSnapshot: () => emptySnapshot,
      recordOutgoingCommand: () => {},
      reportSessionOptions: () => {},
      replaceModels: () => {}
    }))
  })

  it('retires a persisted id against models the probe already cached', async () => {
    ensureNativeChatModelEnrichment({
      agent: 'grok',
      hostKey: 'local',
      discover: async () => models('grok-4.5')
    })
    await vi.waitFor(() => expect(readNativeChatEnrichedModels('grok', 'local')).not.toBeNull())

    mountPane()

    await vi.waitFor(() =>
      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        LOCAL_TARGET,
        'settings.mutateNativeChatSessionOptions',
        expect.objectContaining({ type: 'clear-model-if-missing', agent: 'grok' })
      )
    )
  })

  it('leaves the persisted id alone while the probe is still in flight', async () => {
    mocks.discoverNativeChatCatalogModels.mockReturnValue(new Promise(() => {}))

    mountPane()

    await Promise.resolve()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps PTY picks in the client settings record used by paired launches', async () => {
    mountPane()
    const persistSelection = mocks.createNativeChatPtySessionOptions.mock.calls[0]?.[0]
      ?.persistSelection as
      | ((pick: {
          modelId: string
          optionId: string
          value: string
          adoptModelAsLaunchDefault: boolean
        }) => Promise<void>)
      | undefined

    await persistSelection?.({
      modelId: 'grok-4.5',
      optionId: 'effort',
      value: 'high',
      adoptModelAsLaunchDefault: true
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      LOCAL_TARGET,
      'settings.mutateNativeChatSessionOptions',
      expect.objectContaining({ type: 'apply-picks', agent: 'grok' })
    )
  })
})
