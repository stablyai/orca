import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
import {
  getCodexStatusRuntimeKey,
  getCodexStatusRuntimeLabel,
  getCodexStatusWslKey,
  type ClaudeStatusSwitchGroup,
  type CodexStatusRuntimeTarget,
  type StatusSwitchGroupOptions
} from './status-bar-runtime-targets'

type ClaudeStatusAccount = ClaudeRateLimitAccountsState['accounts'][number]

function getSingleConcreteClaudeWslDistro(state: ClaudeRateLimitAccountsState): string | null {
  const keys = new Set<string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      keys.add(key)
    }
  }
  for (const account of state.accounts) {
    const key = getCodexStatusWslKey(account.wslDistro)
    if (account.managedAuthRuntime === 'wsl' && key !== '__default__') {
      keys.add(key)
    }
  }
  return keys.size === 1 ? Array.from(keys)[0] : null
}

export function normalizeClaudeStatusRuntimeTarget(
  state: ClaudeRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): CodexStatusRuntimeTarget {
  if (target.runtime !== 'wsl' || target.wslDistro) {
    return target
  }
  const concreteDistro = getSingleConcreteClaudeWslDistro(state)
  return concreteDistro ? { runtime: 'wsl', wslDistro: concreteDistro } : target
}

export function getClaudeStatusActiveId(
  state: ClaudeRateLimitAccountsState,
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

function getClaudeStatusAccountsForTarget(
  state: ClaudeRateLimitAccountsState,
  target: CodexStatusRuntimeTarget
): ClaudeStatusAccount[] {
  if (target.runtime === 'host') {
    return state.accounts.filter((account) => account.managedAuthRuntime !== 'wsl')
  }
  return state.accounts.filter(
    (account) =>
      account.managedAuthRuntime === 'wsl' &&
      getCodexStatusWslKey(account.wslDistro) === getCodexStatusWslKey(target.wslDistro)
  )
}

export function buildClaudeStatusSwitchGroups(
  state: ClaudeRateLimitAccountsState,
  currentTarget: CodexStatusRuntimeTarget,
  options: StatusSwitchGroupOptions = {}
): ClaudeStatusSwitchGroup[] {
  const groups: ClaudeStatusSwitchGroup[] = []
  const normalizedCurrentTarget = normalizeClaudeStatusRuntimeTarget(state, currentTarget)
  const makeGroup = (target: CodexStatusRuntimeTarget): ClaudeStatusSwitchGroup => {
    const activeId = getClaudeStatusActiveId(state, target)
    const accountsForTarget = getClaudeStatusAccountsForTarget(state, target)
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
          label: account.email,
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
    if (account.managedAuthRuntime === 'wsl') {
      wslKeys.add(getCodexStatusWslKey(account.wslDistro))
    }
  }
  if (options.includeFallbackWsl) {
    wslKeys.add(getCodexStatusWslKey(options.fallbackWslDistro))
  }
  if (currentTarget.runtime === 'wsl' && currentTarget.wslDistro === null) {
    const concreteDistro = getSingleConcreteClaudeWslDistro(state)
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

function getClaudeStatusAccountsFromSettings(
  settings: GlobalSettings | null | undefined
): ClaudeRateLimitAccountsState | null {
  if (!settings) {
    return null
  }
  return {
    accounts: settings.claudeManagedAccounts
      .map((account) => ({
        id: account.id,
        email: account.email,
        managedAuthRuntime: account.managedAuthRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null,
        authMethod: account.authMethod ?? 'unknown',
        organizationUuid: account.organizationUuid ?? null,
        organizationName: account.organizationName ?? null,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    activeAccountId:
      settings.activeClaudeManagedAccountIdsByRuntime?.host ??
      settings.activeClaudeManagedAccountId ??
      null,
    activeAccountIdsByRuntime: {
      host:
        settings.activeClaudeManagedAccountIdsByRuntime?.host ??
        settings.activeClaudeManagedAccountId ??
        null,
      wsl: { ...settings.activeClaudeManagedAccountIdsByRuntime?.wsl }
    }
  }
}

// Why: with a Remote Orca Server, local GlobalSettings describe this desktop, not the owner — the server snapshot wins (#7973).

export function resolveClaudeStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: ClaudeRateLimitAccountsState
): ClaudeRateLimitAccountsState {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getClaudeStatusAccountsFromSettings(settings) ?? runtimeState
}
