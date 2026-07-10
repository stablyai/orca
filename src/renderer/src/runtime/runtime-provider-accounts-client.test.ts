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
