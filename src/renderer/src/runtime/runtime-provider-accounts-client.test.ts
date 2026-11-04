import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/managed-account-types'
import {
  fetchProviderAccountsSnapshot,
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from './runtime-provider-accounts-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const LOCAL = { kind: 'local' } as const

function emptyClaudeState(): ClaudeRateLimitAccountsState {
  return { accounts: [], activeAccountId: null, activeAccountIdsByRuntime: { host: null, wsl: {} } }
}

function emptyCodexState(): CodexRateLimitAccountsState {
  return { accounts: [], activeAccountId: null, activeAccountIdsByRuntime: { host: null, wsl: {} } }
}

function snapshotFixture(marker: string): ProviderAccountsSnapshot {
  return {
    claude: {
      ...emptyClaudeState(),
      activeAccountId: `claude-${marker}`
    },
    codex: {
      ...emptyCodexState(),
      activeAccountId: `codex-${marker}`
    },
    rateLimits: null
  }
}

type SubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()
const claudeListLocal = vi.fn()
const codexListLocal = vi.fn()
const claudeSelectLocal = vi.fn()
const codexSelectLocal = vi.fn()
const claudeRemoveLocal = vi.fn()
const codexRemoveLocal = vi.fn()
const unsubscribe = vi.fn()

let subscriptionCallbacks: SubscriptionCallbacks | null = null

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.restoreAllMocks()
  for (const mock of [
    runtimeEnvironmentCall,
    runtimeEnvironmentTransportCall,
    runtimeEnvironmentSubscribe,
    claudeListLocal,
    codexListLocal,
    claudeSelectLocal,
    codexSelectLocal,
    claudeRemoveLocal,
    codexRemoveLocal,
    unsubscribe
  ]) {
    mock.mockReset()
  }
  subscriptionCallbacks = null
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  runtimeEnvironmentSubscribe.mockImplementation(
    async (_args: unknown, callbacks: SubscriptionCallbacks) => {
      subscriptionCallbacks = callbacks
      return { unsubscribe, sendBinary: () => false }
    }
  )
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        subscribe: runtimeEnvironmentSubscribe
      },
      claudeAccounts: {
        list: claudeListLocal,
        select: claudeSelectLocal,
        remove: claudeRemoveLocal
      },
      codexAccounts: {
        list: codexListLocal,
        select: codexSelectLocal,
        remove: codexRemoveLocal
      }
    }
  })
})

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('watchProviderAccounts', () => {
  it('does not deliver a late local snapshot after close', async () => {
    let resolveClaude: (state: ClaudeRateLimitAccountsState) => void = () => {}
    claudeListLocal.mockImplementation(
      () => new Promise<ClaudeRateLimitAccountsState>((resolve) => (resolveClaude = resolve))
    )
    codexListLocal.mockResolvedValue(emptyCodexState())
    const snapshots: ProviderAccountsSnapshot[] = []

    const watcher = watchProviderAccounts(LOCAL, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: () => {}
    })
    watcher.close()
    resolveClaude(emptyClaudeState())
    await flushMicrotasks()

    expect(snapshots).toHaveLength(0)
  })
})

describe('fetchProviderAccountsSnapshot', () => {
  it('deduplicates concurrent local reads but does not cache completed snapshots', async () => {
    let resolveClaude!: (state: ClaudeRateLimitAccountsState) => void
    let resolveCodex!: (state: CodexRateLimitAccountsState) => void
    claudeListLocal.mockImplementation(
      () => new Promise<ClaudeRateLimitAccountsState>((resolve) => (resolveClaude = resolve))
    )
    codexListLocal.mockImplementation(
      () => new Promise<CodexRateLimitAccountsState>((resolve) => (resolveCodex = resolve))
    )

    const first = fetchProviderAccountsSnapshot(LOCAL)
    const second = fetchProviderAccountsSnapshot(LOCAL)

    expect(second).toBe(first)
    expect(claudeListLocal).toHaveBeenCalledTimes(1)
    expect(codexListLocal).toHaveBeenCalledTimes(1)

    resolveClaude(emptyClaudeState())
    resolveCodex(emptyCodexState())
    await Promise.all([first, second])

    claudeListLocal.mockResolvedValue(emptyClaudeState())
    codexListLocal.mockResolvedValue(emptyCodexState())
    await fetchProviderAccountsSnapshot(LOCAL)
    expect(claudeListLocal).toHaveBeenCalledTimes(2)
    expect(codexListLocal).toHaveBeenCalledTimes(2)
  })

  it('isolates in-flight snapshots by remote account owner', async () => {
    const first = fetchProviderAccountsSnapshot({ kind: 'environment', environmentId: 'env-1' })
    const second = fetchProviderAccountsSnapshot({ kind: 'environment', environmentId: 'env-2' })
    await flushMicrotasks()

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(2)
    const firstCallbacks = runtimeEnvironmentSubscribe.mock.calls[0]?.[1] as SubscriptionCallbacks
    const secondCallbacks = runtimeEnvironmentSubscribe.mock.calls[1]?.[1] as SubscriptionCallbacks
    firstCallbacks.onResponse({
      ok: true,
      result: { type: 'ready', snapshot: snapshotFixture('one') }
    })
    secondCallbacks.onResponse({
      ok: true,
      result: { type: 'ready', snapshot: snapshotFixture('two') }
    })

    await expect(first).resolves.toMatchObject({ codex: { activeAccountId: 'codex-one' } })
    await expect(second).resolves.toMatchObject({ codex: { activeAccountId: 'codex-two' } })
  })

  it('does not share a local read with a remote environment named local', async () => {
    let resolveClaude!: (state: ClaudeRateLimitAccountsState) => void
    let resolveCodex!: (state: CodexRateLimitAccountsState) => void
    claudeListLocal.mockImplementation(
      () => new Promise<ClaudeRateLimitAccountsState>((resolve) => (resolveClaude = resolve))
    )
    codexListLocal.mockImplementation(
      () => new Promise<CodexRateLimitAccountsState>((resolve) => (resolveCodex = resolve))
    )

    const local = fetchProviderAccountsSnapshot(LOCAL)
    const remote = fetchProviderAccountsSnapshot({ kind: 'environment', environmentId: 'local' })
    await flushMicrotasks()

    expect(remote).not.toBe(local)
    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(1)
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'ready', snapshot: snapshotFixture('remote-local') }
    })
    resolveClaude(emptyClaudeState())
    resolveCodex(emptyCodexState())

    await expect(remote).resolves.toMatchObject({
      codex: { activeAccountId: 'codex-remote-local' }
    })
    await expect(local).resolves.toMatchObject({ codex: { activeAccountId: null } })
  })
})
