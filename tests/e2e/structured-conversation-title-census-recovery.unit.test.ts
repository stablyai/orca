import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useAiVaultSessionRefresh } from '../../src/renderer/src/components/right-sidebar/ai-vault-session-refresh'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '@/components/right-sidebar/ai-vault-session-limit'
import type { AiVaultListResult } from '../../src/shared/ai-vault-types'
// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeSessionTabsInventory } from '../../src/main/runtime/rpc/methods/session-tabs-inventory'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { resolveLocalAiVaultSessionTitles } from '../../src/main/ai-vault/session-title-resolver'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionRecordFixture } from '../../src/shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../src/shared/agent-session-provider-handle-encoding'
import type { AiVaultSessionTitlesArgs } from '../../src/shared/ai-vault-session-title'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { useAppStore } from '@/store'
import { session, result } from '@/components/right-sidebar/ai-vault-structured-title-fixtures'
import {
  cacheAiVaultSessionResult,
  readAiVaultSessionResultSnapshot,
  resetAiVaultSessionResultCacheForTest
} from '@/components/right-sidebar/ai-vault-session-result-cache'
import {
  startLocalStructuredSessionTabsSync,
  resetLocalStructuredSessionVersionForTests
} from '../../src/renderer/src/runtime/local-structured-session-tabs-sync'
import { handleGlobalSessionInventoryEvent } from '../../src/renderer/src/runtime/web-session-tabs-sync/global-session-inventory-event'
import { getWebSessionTabsTrackingGeneration } from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { getRuntimeEnvironmentRevision } from '../../src/renderer/src/runtime/runtime-environment-revision'
import { VisibilityResumeCoordinator } from '../../src/renderer/src/runtime/web-session-tabs-sync/visibility-resume-coordinator'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync'

vi.mock('../../src/main/ai-vault/session-scanner-background', () => ({
  resolveAiVaultSessionTitlesInBackground: vi.fn(async () => ({ titles: [] }))
}))
vi.mock('../../src/renderer/src/lib/structured-agent-session-launch-unconfirmed-recheck', () => ({
  recheckUnconfirmedStructuredAgentLaunches: vi.fn()
}))
const initial = useAppStore.getInitialState()
let name: string | undefined
let cleanup = () => {}
const resolveTitles = vi.fn(async (args: AiVaultSessionTitlesArgs) =>
  resolveLocalAiVaultSessionTitles(args.requests)
)
function snapshot(version = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'folder-workspace',
    publicationEpoch: 'host:one',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}
beforeEach(() => {
  name = undefined
  cleanup = () => {}
  useAppStore.setState(initial, true)
  resetAiVaultSessionResultCacheForTest()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resolveTitles.mockClear()
  const fixture = agentSessionRecordFixture()
  const record = {
    ...fixture,
    sessionId: 'native-session',
    provider: 'codex' as const,
    location: { ...fixture.location, workspaceId: 'folder-workspace' },
    providerHandleChain: [
      { ...fixture.providerHandleChain[0]!, handle: codexProviderHandle('provider-session') }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this host's native title resolver only reads getRecord and its current name.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getRecord: (id: string) =>
          id === record.sessionId
            ? { ...record, ...(name ? { conversationName: name } : {}) }
            : null
      }
    }
  } as never)
})
afterEach(() => {
  cleanup()
  setStructuredAgentSessionHost(null)
  useAppStore.setState(initial, true)
  resetAiVaultSessionResultCacheForTest()
  vi.useRealTimers()
})
function cache(host: 'local' | 'runtime:paired-host'): void {
  cacheAiVaultSessionResult({
    key: 'census-recovery',
    executionHostScope: host,
    limit: 500,
    result: result(session(host)),
    replaceHostEntries: false
  })
}
it.each(['coalesced', 'census-covered'] as const)(
  'recovers a closed name lost by actual host initialization: %s',
  async (loss) => {
    cache('local')
    let receive: (response: unknown) => void = () => {}
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: { resolveSessionTitles: resolveTitles },
        runtime: {
          getStatus: vi.fn(async () => ({
            capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          })),
          call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } })),
          subscribe: vi.fn(async (_params: unknown, callback: (response: unknown) => void) => {
            receive = callback
            return { unsubscribe: () => {} }
          })
        }
      }
    })
    await startLocalStructuredSessionTabsSync({
      isDisposed: () => false,
      setUnsubscribe: (stop) => {
        cleanup = stop
      }
    })
    const census = Promise.withResolvers<{
      snapshots: RuntimeMobileSessionTabsResult[]
      changeSequence: number
    }>()
    let changed: (value: RuntimeMobileSessionTabsResult, sequence: number) => void = () => {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: subscribeAll uses only these inventory and subscription members on this fake execution host.
    const runtime = {
      supportsAuthoritativeSessionTabsInventory: () => true,
      listAllMobileSessionTabsInventoryWithChangeSequence: () => census.promise,
      onMobileSessionTabsChanged: (listener: typeof changed) => {
        changed = listener
        return () => {}
      },
      registerSubscriptionCleanup: () => {},
      cleanupSubscription: () => {}
    } as unknown as OrcaRuntimeService
    const emitted: unknown[] = []
    const subscribing = subscribeSessionTabsInventory(
      { runtime, connectionId: 'connection', requestId: 'census' },
      (event) => {
        emitted.push(event)
        receive({ ok: true, result: event })
      }
    )
    name = 'Saved during census'
    changed(
      {
        ...snapshot(2),
        structuredConversationTitle: { sessionId: 'native-session', agent: 'codex', title: name }
      },
      1
    )
    if (loss === 'coalesced') {
      changed(snapshot(3), 2)
    }
    census.resolve({ snapshots: [snapshot(4)], changeSequence: loss === 'coalesced' ? 0 : 1 })
    await subscribing
    await vi.waitFor(() =>
      expect(readAiVaultSessionResultSnapshot('census-recovery')?.sessions[0]?.title).toBe(name)
    )
    expect(JSON.stringify(emitted)).not.toContain('structuredConversationTitle')
    expect(resolveTitles).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 12; index++) {
      changed(snapshot(5 + index), 3 + index)
    }
    expect(resolveTitles).toHaveBeenCalledTimes(1)
  }
)
it('repairs cached paired titles at the actual inventory receiver and fences a late disconnected reply', async () => {
  cache('runtime:paired-host')
  name = 'Saved while disconnected'
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { resolveSessionTitles: resolveTitles } }
  })
  let current = true
  const coordinator = new VisibilityResumeCoordinator({
    environments: [],
    environmentIdBySubscriptionSpec: [],
    omissions: new Map(),
    activeRuntimeWorktreeKey: () => null
  })
  const deliver = () =>
    handleGlobalSessionInventoryEvent({
      environmentId: 'paired-host',
      expectedEnvironmentConnectionGeneration:
        getRuntimeEnvironmentConnectionGeneration('paired-host'),
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision('paired-host'),
      expectedTrackingGeneration: getWebSessionTabsTrackingGeneration('paired-host'),
      visibilityGeneration: 0,
      isCurrent: () => current,
      event: { type: 'snapshots', snapshots: [snapshot()] },
      replayed: false,
      awaitingVisibilityResumeInventory: { value: false },
      coordinator
    })
  deliver()
  await vi.waitFor(() =>
    expect(readAiVaultSessionResultSnapshot('census-recovery')?.sessions[0]?.title).toBe(name)
  )
  const delayed =
    Promise.withResolvers<Awaited<ReturnType<typeof resolveLocalAiVaultSessionTitles>>>()
  resolveTitles.mockReturnValueOnce(delayed.promise)
  deliver()
  await vi.waitFor(() => expect(resolveTitles).toHaveBeenCalledTimes(2))
  current = false
  delayed.resolve({
    titles: [
      {
        agent: 'codex',
        sessionId: 'provider-session',
        title: 'Late disconnected name',
        structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-session' }
      }
    ]
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(readAiVaultSessionResultSnapshot('census-recovery')?.sessions[0]?.title).toBe(
    'Saved while disconnected'
  )
})

it('repairs the first Vault result when census arrives before any row is cached', async () => {
  const scan = Promise.withResolvers<AiVaultListResult>()
  let receive: (response: unknown) => void = () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        resolveSessionTitles: resolveTitles,
        listSessions: () => scan.promise,
        cancelListSessions: vi.fn(async () => {}),
        onWindowFocused: () => () => {}
      },
      runtime: {
        getStatus: vi.fn(async () => ({
          capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        })),
        call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } })),
        subscribe: vi.fn(async (_params: unknown, callback: typeof receive) => {
          receive = callback
          return { unsubscribe: () => {} }
        })
      }
    }
  })
  await startLocalStructuredSessionTabsSync({
    isDisposed: () => false,
    setUnsubscribe: (stop) => {
      cleanup = stop
    }
  })
  let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
  function Probe(): null {
    latest = useAiVaultSessionRefresh(['/folder'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT)
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Probe)))
    name = 'Saved before first list'
    receive({ ok: true, result: { type: 'snapshots', snapshots: [snapshot()] } })
    await act(async () => scan.resolve(result()))
    await vi.waitFor(() => expect(latest?.sessions[0]?.title).toBe(name))
    expect(resolveTitles).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})

it('finishes cache-owned repair while the panel is hidden and reuses its repaired row', async () => {
  const delayed =
    Promise.withResolvers<Awaited<ReturnType<typeof resolveLocalAiVaultSessionTitles>>>()
  resolveTitles.mockReturnValueOnce(delayed.promise)
  const list = vi.fn(async () => result())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        resolveSessionTitles: resolveTitles,
        listSessions: list,
        cancelListSessions: vi.fn(async () => {}),
        onWindowFocused: () => () => {}
      }
    }
  })
  let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
  function Probe(): null {
    latest = useAiVaultSessionRefresh(['/hidden-folder'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT)
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Probe)))
    expect(resolveTitles).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    delayed.resolve({
      titles: [
        {
          agent: 'codex',
          sessionId: 'provider-session',
          title: 'Recovered while hidden',
          structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-session' }
        }
      ]
    })
    await act(async () => root.render(createElement(Probe)))
    expect(latest?.sessions[0]?.title).toBe('Recovered while hidden')
    expect(list).toHaveBeenCalledTimes(1)
    expect(resolveTitles).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})
