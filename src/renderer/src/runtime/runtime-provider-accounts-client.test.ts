import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/types'
import {
  fetchProviderAccountsSnapshot,
  removeClaudeProviderAccount,
  removeCodexProviderAccount,
  selectClaudeProviderAccount,
  selectCodexProviderAccount,
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from './runtime-provider-accounts-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const LOCAL = { activeRuntimeEnvironmentId: null }
const REMOTE = { activeRuntimeEnvironmentId: 'env-1' }

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
  it('reads local services once when no runtime environment is active', async () => {
    claudeListLocal.mockResolvedValue(emptyClaudeState())
    codexListLocal.mockResolvedValue(emptyCodexState())
    const snapshots: ProviderAccountsSnapshot[] = []

    watchProviderAccounts(LOCAL, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: () => {
        throw new Error('unexpected error')
      }
    })
    await flushMicrotasks()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.rateLimits).toBeNull()
    expect(claudeListLocal).toHaveBeenCalledTimes(1)
    expect(codexListLocal).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
  })

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

  it('keeps a healthy local provider snapshot when the other provider fails', async () => {
    const codexState = { ...emptyCodexState(), activeAccountId: 'codex-local' }
    claudeListLocal.mockRejectedValue(new Error('Claude keychain unavailable'))
    codexListLocal.mockResolvedValue(codexState)
    const snapshots: ProviderAccountsSnapshot[] = []
    const errors: unknown[] = []

    watchProviderAccounts(LOCAL, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error)
    })
    await flushMicrotasks()

    expect(snapshots).toEqual([
      {
        claude: emptyClaudeState(),
        codex: codexState,
        rateLimits: null,
        failedProviders: ['claude']
      }
    ])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe(
      'Could not load Claude accounts: Claude keychain unavailable'
    )
  })

  it('keeps a healthy Claude snapshot when only Codex fails', async () => {
    const claudeState = { ...emptyClaudeState(), activeAccountId: 'claude-local' }
    claudeListLocal.mockResolvedValue(claudeState)
    codexListLocal.mockRejectedValue(new Error('Codex home missing'))
    const snapshots: ProviderAccountsSnapshot[] = []
    const errors: unknown[] = []

    watchProviderAccounts(LOCAL, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error)
    })
    await flushMicrotasks()

    expect(snapshots).toEqual([
      {
        claude: claudeState,
        codex: emptyCodexState(),
        rateLimits: null,
        failedProviders: ['codex']
      }
    ])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('Could not load Codex accounts: Codex home missing')
  })

  it('aggregates errors without a snapshot when both local providers fail', async () => {
    claudeListLocal.mockRejectedValue(new Error('Claude keychain unavailable'))
    codexListLocal.mockRejectedValue(new Error('Codex home missing'))
    const snapshots: ProviderAccountsSnapshot[] = []
    const errors: unknown[] = []

    watchProviderAccounts(LOCAL, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error)
    })
    await flushMicrotasks()

    expect(snapshots).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect((errors[0] as AggregateError).message).toContain('Could not load Claude accounts')
    expect((errors[0] as AggregateError).message).toContain('Could not load Codex accounts')
    expect((errors[0] as AggregateError).errors).toHaveLength(2)
  })

  it('streams remote snapshots from accounts.subscribe and unsubscribes on close', async () => {
    const snapshots: ProviderAccountsSnapshot[] = []
    const watcher = watchProviderAccounts(REMOTE, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: () => {
        throw new Error('unexpected error')
      }
    })
    await flushMicrotasks()

    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'accounts.subscribe' }),
      expect.any(Object)
    )
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'ready', snapshot: snapshotFixture('ready') }
    })
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'snapshot', snapshot: snapshotFixture('refresh') }
    })

    expect(snapshots.map((s) => s.codex.activeAccountId)).toEqual(['codex-ready', 'codex-refresh'])
    expect(claudeListLocal).not.toHaveBeenCalled()

    watcher.close()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'snapshot', snapshot: snapshotFixture('late') }
    })
    expect(snapshots).toHaveLength(2)
  })

  it('surfaces remote subscription failures as errors', async () => {
    const errors: unknown[] = []
    watchProviderAccounts(REMOTE, {
      onSnapshot: () => {
        throw new Error('unexpected snapshot')
      },
      onError: (error) => errors.push(error)
    })
    await flushMicrotasks()

    subscriptionCallbacks?.onResponse({
      ok: false,
      error: { code: 'forbidden', message: 'denied' }
    })

    expect(errors).toHaveLength(1)
    expect(String((errors[0] as Error).message)).toContain('denied')
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
    const first = fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: 'env-1' })
    const second = fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: 'env-2' })
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
    const remote = fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: 'local' })
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

  it('resolves with the first remote snapshot and closes the subscription', async () => {
    const pending = fetchProviderAccountsSnapshot(REMOTE)
    await flushMicrotasks()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'ready', snapshot: snapshotFixture('ready') }
    })

    await expect(pending).resolves.toMatchObject({
      codex: { activeAccountId: 'codex-ready' }
    })
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('rejects when the remote subscription closes before any snapshot', async () => {
    const pending = fetchProviderAccountsSnapshot(REMOTE)
    await flushMicrotasks()
    subscriptionCallbacks?.onClose?.()

    await expect(pending).rejects.toThrow('subscription closed')
  })

  it('resolves partial local snapshots so one healthy provider is still usable', async () => {
    const codexState = { ...emptyCodexState(), activeAccountId: 'codex-local' }
    claudeListLocal.mockRejectedValue(new Error('Claude keychain unavailable'))
    codexListLocal.mockResolvedValue(codexState)

    // Why: one-shot consumers (status bar menus) must keep the healthy provider
    // even when the sibling list rejects instead of seeing a rejected promise.
    await expect(fetchProviderAccountsSnapshot(LOCAL)).resolves.toEqual({
      claude: emptyClaudeState(),
      codex: codexState,
      rateLimits: null,
      failedProviders: ['claude']
    })
  })
})

describe('provider account mutations', () => {
  it('routes select through local IPC with the full runtime target when local', async () => {
    codexSelectLocal.mockResolvedValue(emptyCodexState())
    claudeSelectLocal.mockResolvedValue(emptyClaudeState())

    await selectCodexProviderAccount(LOCAL, {
      accountId: 'acc-1',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    await selectClaudeProviderAccount(LOCAL, { accountId: null, runtime: 'host', wslDistro: null })

    expect(codexSelectLocal).toHaveBeenCalledWith({
      accountId: 'acc-1',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(claudeSelectLocal).toHaveBeenCalledWith({
      accountId: null,
      runtime: 'host',
      wslDistro: null
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes select and remove through the active runtime accounts RPC when remote', async () => {
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => ({
      id: 'call',
      ok: true,
      result: args.method.startsWith('accounts.select') ? emptyCodexState() : emptyClaudeState()
    }))

    await selectCodexProviderAccount(REMOTE, {
      accountId: 'server-codex-2',
      runtime: 'host',
      wslDistro: null
    })
    await selectClaudeProviderAccount(REMOTE, {
      accountId: null,
      runtime: 'host',
      wslDistro: null
    })
    await removeCodexProviderAccount(REMOTE, 'server-codex-1')
    await removeClaudeProviderAccount(REMOTE, 'server-claude-1')

    const methods = runtimeEnvironmentCall.mock.calls.map(
      (call) => (call[0] as { method: string; params: unknown }).method
    )
    expect(methods).toEqual([
      'accounts.selectCodex',
      'accounts.selectClaude',
      'accounts.removeCodex',
      'accounts.removeClaude'
    ])
    expect(runtimeEnvironmentCall.mock.calls[0]?.[0]).toMatchObject({
      selector: 'env-1',
      // Why this matters: the server API takes only accountId; host/WSL
      // targeting is a desktop-local concept and must not leak into params.
      params: { accountId: 'server-codex-2' }
    })
    expect(codexSelectLocal).not.toHaveBeenCalled()
    expect(claudeSelectLocal).not.toHaveBeenCalled()
    expect(codexRemoveLocal).not.toHaveBeenCalled()
    expect(claudeRemoveLocal).not.toHaveBeenCalled()
  })
})
