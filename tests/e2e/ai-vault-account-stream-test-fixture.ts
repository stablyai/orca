import { vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import {
  RuntimeAccountController,
  type RuntimeAccountServices
} from '../../src/main/runtime/runtime-account-controller'
import { RuntimeSubscriptionRegistry } from '../../src/main/runtime/runtime-subscription-registry'
import { RateLimitService } from '../../src/main/rate-limits/service'
import { getManagedDataAccountService } from '../../src/main/managed-data-accounts/service'
import { ACCOUNT_METHODS } from '../../src/main/runtime/rpc/methods/accounts'
import {
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext
} from '../../src/main/runtime/rpc/core'
import { accountStreamDesktopFixture } from './ai-vault-account-stream-desktop-test-fixture'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../src/shared/managed-account-types'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState
} from '@/runtime/runtime-provider-accounts-client'

type StreamServicePorts = {
  claudeAccounts: Pick<RuntimeAccountServices['claudeAccounts'], 'listAccounts'>
  codexAccounts: Pick<RuntimeAccountServices['codexAccounts'], 'listAccounts'>
  rateLimits: RateLimitService
}
type StreamRuntime = Pick<
  RpcContext['runtime'],
  | 'getAccountsSnapshot'
  | 'getAccountsStreamSnapshot'
  | 'getDataAccountsSnapshot'
  | 'onAccountsChanged'
  | 'registerSubscriptionCleanup'
  | 'cleanupSubscription'
  | 'cleanupSubscriptionsForConnection'
  | 'getRuntimeId'
  | 'refreshAccountsForMobileSubscriber'
>

type StreamContext = { runtime: StreamRuntime; connectionId?: string }
type StreamControllerPort = { setServices(services: StreamServicePorts): void }
type RequestHandlerPort = { handler(params: unknown, context: StreamContext): unknown }

export const P = '11111111-1111-4111-8111-111111111111'
export const Q = '22222222-2222-4222-8222-222222222222'
export const D = '33333333-3333-4333-8333-333333333333'
export const profile = (id: string, label: string) => ({
  id,
  label,
  integrations: [],
  createdAt: 1
})
class PublishedRateLimits extends RateLimitService {
  publish(): void {
    this.updateState({
      ...this.state,
      codex: {
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: (this.state.codex?.updatedAt ?? 0) + 1,
        status: 'ok',
        error: null
      }
    })
  }
}

export function accountStreamFixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'orca-pr35392-stream-'))
  installFakeAppEnvironment({ getPath: () => root })
  const service = getManagedDataAccountService()
  const directory = join(root, 'managed-data-accounts')
  const registry = (provider: ManagedDataAccountProvider) =>
    join(directory, provider, 'accounts.json')
  const seed = (
    provider: ManagedDataAccountProvider,
    accounts: ManagedDataAccountsState['accounts']
  ) => {
    fs.mkdirSync(join(directory, provider), { recursive: true })
    for (const account of accounts) {
      fs.mkdirSync(join(directory, provider, account.id), { recursive: true })
    }
    fs.writeFileSync(registry(provider), JSON.stringify({ accounts, activeAccountId: null }))
  }
  seed('opencode', [profile(P, 'Work'), profile(Q, 'Other')])
  seed('devin', [profile(D, 'Devin')])
  const usage = new PublishedRateLimits()
  const refresh = vi.spyOn(usage, 'refreshIfStale').mockResolvedValue(usage.getState())
  vi.spyOn(usage, 'fetchInactiveClaudeAccountsOnOpen').mockResolvedValue(undefined)
  vi.spyOn(usage, 'fetchInactiveCodexAccountsOnOpen').mockResolvedValue(undefined)
  const nativeClaude = vi.fn(() => ({
    ...emptyClaudeAccountsState(),
    accounts: [
      {
        id: 'healthy-claude',
        email: 'claude@example.com',
        authMethod: 'unknown' as const,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }))
  const nativeCodex = vi.fn(() => ({
    ...emptyCodexAccountsState(),
    accounts: [
      {
        id: 'healthy-codex',
        email: 'codex@example.com',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }))
  const controller = new RuntimeAccountController()
  // The stream producer calls only these native list ports; no native disk IO is part of this contract.
  const services: StreamServicePorts = {
    claudeAccounts: { listAccounts: nativeClaude },
    codexAccounts: { listAccounts: nativeCodex },
    rateLimits: usage
  }
  const controllerPort: StreamControllerPort = controller
  controllerPort.setServices(services)
  const subscriptions = new RuntimeSubscriptionRegistry()
  const runtime: StreamRuntime = {
    getAccountsSnapshot: controller.getSnapshot.bind(controller),
    getAccountsStreamSnapshot: controller.getStreamSnapshot.bind(controller),
    getDataAccountsSnapshot: controller.dataAccountsSnapshot.bind(controller),
    onAccountsChanged: controller.onChanged.bind(controller),
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    cleanupSubscriptionsForConnection: subscriptions.cleanupForConnection.bind(subscriptions),
    getRuntimeId: () => 'fixture',
    refreshAccountsForMobileSubscriber: controller.refreshForMobileSubscriber.bind(controller)
  }
  const methods = eraseRpcMethods(ACCOUNT_METHODS)
  const frames: unknown[] = []
  const observations: ReturnType<typeof counters>[] = []
  const observe = (run: () => void) => {
    const before = counters()
    run()
    const after = counters()
    observations.push({
      lists: after.lists - before.lists,
      reads: after.reads - before.reads,
      parses: after.parses - before.parses,
      claude: after.claude - before.claude,
      codex: after.codex - before.codex,
      frames: after.frames - before.frames,
      listData: after.listData - before.listData
    })
  }
  let dataListeners = 0
  let usageListeners = 0
  const originalDataOnChanged = service.onChanged.bind(service)
  vi.spyOn(service, 'onChanged').mockImplementation((listener) => {
    dataListeners++
    const close = originalDataOnChanged(() => observe(listener))
    return () => {
      dataListeners--
      close()
    }
  })
  const originalUsageOnChanged = usage.onStateChange.bind(usage)
  vi.spyOn(usage, 'onStateChange').mockImplementation((listener) => {
    usageListeners++
    const close = originalUsageOnChanged((state) => observe(() => listener(state)))
    return () => {
      usageListeners--
      close()
    }
  })
  const desktop = accountStreamDesktopFixture(runtime, frames)
  const { subscribe } = desktop
  window.api.runtime = { ...window.api.runtime, subscribe }
  const listData = vi.fn()
  window.api.runtime.call = listData
  const lists = vi.spyOn(service, 'list')
  const reads = vi.spyOn(fs, 'readFileSync')
  const parses = vi.spyOn(JSON, 'parse')
  const counters = () => {
    const registryReads = reads.mock.calls.flatMap(([path], index) =>
      String(path) === registry('opencode') || String(path) === registry('devin')
        ? [reads.mock.results[index]?.value]
        : []
    )
    const registryText = new Set<unknown>(registryReads)
    return {
      lists: lists.mock.calls.length,
      reads: registryReads.length,
      parses: parses.mock.calls.filter(([text]) => registryText.has(text)).length,
      claude: nativeClaude.mock.calls.length,
      codex: nativeCodex.mock.calls.length,
      frames: frames.length,
      listData: listData.mock.calls.length
    }
  }

  return {
    controller,
    runtime,
    subscriptions,
    ...desktop,
    service,
    usage,
    subscribe,
    frames,
    refresh,
    registry,
    seed,
    counters,
    observations,
    listenerCounts: () => [dataListeners, usageListeners],
    callStrict: (name: string) => {
      const strict = methods.find((candidate) => candidate.name === name)
      if (!strict || isStreamingMethod(strict)) {
        throw new Error('Missing one-shot')
      }
      const request: RequestHandlerPort = strict
      return request.handler(name === 'accounts.list' ? { refreshUsage: false } : null, { runtime })
    },
    dispose: async () => {
      await desktop.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
