import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
import {
  getCodexStatusRuntimeKey,
  getCodexStatusRuntimeLabel,
  getCodexStatusWslKey,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup,
  type StatusSwitchGroupOptions
} from './status-bar-runtime-targets'

type CodexStatusAccount = CodexRateLimitAccountsState['accounts'][number]

function getCodexAccountDisplayLabel(account: CodexStatusAccount): string {
  return account.workspaceLabel ? `${account.email} (${account.workspaceLabel})` : account.email
}

function getSingleConcreteCodexWslDistro(state: CodexRateLimitAccountsState): string | null {
  const keys = new Set<string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      keys.add(key)
    }
  }
  for (const account of state.accounts) {
    const key = getCodexStatusWslKey(account.wslDistro)
    if (account.managedHomeRuntime === 'wsl' && key !== '__default__') {
      keys.add(key)
    }
  }
  return keys.size === 1 ? Array.from(keys)[0] : null
}

export function normalizeCodexStatusRuntimeTarget(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusRuntimeTarget {
  if (target.runtime !== 'wsl' || target.wslDistro) {
    return target
  }
  const concreteDistro = getSingleConcreteCodexWslDistro(state)
  return concreteDistro ? { runtime: 'wsl', wslDistro: concreteDistro } : target
}

export function getCodexStatusActiveId(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): string | null {
  const selection = state.activeAccountIdsByRuntime
  if (target.runtime === 'host') {
    return selection?.host ?? state.activeAccountId ?? null
  }
  const distroSelection = selection?.wsl?.[getCodexStatusWslKey(target.wslDistro)]
  if (target.wslDistro || distroSelection) {
    return distroSelection ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection?.wsl ?? {}).filter(Boolean)))
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function getCodexStatusAccountsForTarget(
  state: CodexRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusAccount[] {
  if (target.runtime === 'host') {
    return state.accounts.filter((account) => account.managedHomeRuntime !== 'wsl')
  }
  return state.accounts.filter(
    (account) =>
      account.managedHomeRuntime === 'wsl' &&
      getCodexStatusWslKey(account.wslDistro) === getCodexStatusWslKey(target.wslDistro)
  )
}

export function buildCodexStatusSwitchGroups(
  state: CodexRateLimitAccountsState,
  currentTarget: CodexStatusRuntimeTarget,
  options: StatusSwitchGroupOptions = {}
): CodexStatusSwitchGroup[] {
  const groups: CodexStatusSwitchGroup[] = []
  const normalizedCurrentTarget = normalizeCodexStatusRuntimeTarget(state, currentTarget)
  const makeGroup = (target: CodexStatusRuntimeTarget): CodexStatusSwitchGroup => {
    const activeId = getCodexStatusActiveId(state, target)
    const accountsForTarget = getCodexStatusAccountsForTarget(state, target)
    return {
      key: getCodexStatusRuntimeKey(target),
      label: getCodexStatusRuntimeLabel(target, options.hostLabel),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'),
          active: activeId === null,
          runtimeTarget: target
        },
        ...accountsForTarget.map((account) => ({
          id: account.id,
          label: getCodexAccountDisplayLabel(account),
          active: account.id === activeId,
          runtimeTarget: target
        }))
      ]
    }
  }

  groups.push(makeGroup({ runtime: 'host', wslDistro: null }))

  const wslKeys = new Set<string>(Object.keys(state.activeAccountIdsByRuntime?.wsl ?? {}))
  if (normalizedCurrentTarget.runtime === 'wsl') {
    wslKeys.add(getCodexStatusWslKey(normalizedCurrentTarget.wslDistro))
  }
  for (const account of state.accounts) {
    if (account.managedHomeRuntime === 'wsl') {
      wslKeys.add(getCodexStatusWslKey(account.wslDistro))
    }
  }
  if (options.includeFallbackWsl) {
    wslKeys.add(getCodexStatusWslKey(options.fallbackWslDistro))
  }
  if (currentTarget.runtime === 'wsl' && currentTarget.wslDistro === null) {
    const concreteDistro = getSingleConcreteCodexWslDistro(state)
    if (concreteDistro) {
      wslKeys.delete('__default__')
    }
  }

  for (const key of Array.from(wslKeys).sort((a, b) => {
    if (a === '__default__') {
      return -1
    }
    if (b === '__default__') {
      return 1
    }
    return a.localeCompare(b)
  })) {
    groups.push(makeGroup({ runtime: 'wsl', wslDistro: key === '__default__' ? null : key }))
  }

  return groups
}

function getCodexStatusAccountsFromSettings(
  settings: GlobalSettings | null | undefined
): CodexRateLimitAccountsState | null {
  if (!settings) {
    return null
  }
  return {
    accounts: settings.codexManagedAccounts
      .map((account) => ({
        id: account.id,
        email: account.email,
        managedHomeRuntime: account.managedHomeRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null,
        providerAccountId: account.providerAccountId ?? null,
        workspaceLabel: account.workspaceLabel ?? null,
        workspaceAccountId: account.workspaceAccountId ?? null,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    activeAccountId:
      settings.activeCodexManagedAccountIdsByRuntime?.host ??
      settings.activeCodexManagedAccountId ??
      null,
    activeAccountIdsByRuntime: {
      host:
        settings.activeCodexManagedAccountIdsByRuntime?.host ??
        settings.activeCodexManagedAccountId ??
        null,
      wsl: { ...settings.activeCodexManagedAccountIdsByRuntime?.wsl }
    }
  }
}

export function resolveCodexStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: CodexRateLimitAccountsState
): CodexRateLimitAccountsState {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getCodexStatusAccountsFromSettings(settings) ?? runtimeState
}
