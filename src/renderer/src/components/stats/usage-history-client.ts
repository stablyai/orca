import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { UsageHistoryProvider } from '../../../../shared/usage-history-types'
import {
  USAGE_HISTORY_RUNTIME_CAPABILITY,
  type UsageHistorySnapshot,
  type UsageSnapshotQuery
} from '../../../../shared/usage-history-rpc'
import { isWebClientLocation } from '@/lib/web-client-location'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import {
  fetchProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type { ManagedDataAccountsState } from '../../../../shared/managed-account-types'

const HISTORY_REFRESH_TIMEOUT_MS = 15 * 60_000

export async function usageHistoryAccounts(
  target: RuntimeClientTarget
): Promise<ProviderAccountsSnapshot> {
  const accounts = await fetchProviderAccountsSnapshot(target)
  if (accounts.opencode) {
    return accounts
  }
  try {
    const data = await callRuntimeRpc<{ opencode?: ManagedDataAccountsState }>(
      target,
      'accounts.listData'
    )
    return { ...accounts, opencode: data.opencode }
  } catch {
    return accounts
  }
}

export async function resolveUsageHistoryTarget(
  target: RuntimeClientTarget
): Promise<RuntimeClientTarget> {
  if (target.kind === 'local' && isWebClientLocation()) {
    const environments = await window.api.runtimeEnvironments.list()
    const paired = environments?.length === 1 ? environments[0] : null
    if (!paired) {
      throw new Error('The paired historical usage host is unavailable')
    }
    return { kind: 'environment', environmentId: paired.id }
  }
  return target
}

export async function supportsUsageHistory(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(
      target.environmentId,
      USAGE_HISTORY_RUNTIME_CAPABILITY
    )
  }
  if (isWebClientLocation()) {
    const status = await window.api.runtime.getStatus()
    return status.capabilities?.includes(USAGE_HISTORY_RUNTIME_CAPABILITY) === true
  }
  return true
}

export function usageHistoryApi(target: RuntimeClientTarget, provider: UsageHistoryProvider) {
  if (target.kind === 'environment' || isWebClientLocation()) {
    return {
      getSnapshot: (query: UsageSnapshotQuery) =>
        callRuntimeRpc<UsageHistorySnapshot>(target, 'usage.getSnapshot', { provider, ...query }),
      refresh: ({ force }: { force?: boolean }) =>
        callRuntimeRpc(
          target,
          'usage.refresh',
          { provider, force },
          {
            timeoutMs: HISTORY_REFRESH_TIMEOUT_MS
          }
        ),
      setEnabled: ({ enabled }: { enabled: boolean }) =>
        callRuntimeRpc(target, 'usage.setEnabled', { provider, enabled })
    }
  }
  switch (provider) {
    case 'claude':
      return window.api.claudeUsage
    case 'codex':
      return window.api.codexUsage
    case 'opencode':
      return window.api.openCodeUsage
    case 'muse':
      return window.api.museUsage
  }
}
