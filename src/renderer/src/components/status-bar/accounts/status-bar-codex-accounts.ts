import {
  getManagedAccountDisplayName,
  getManagedAccountPrimaryLabel
} from '../../../../../shared/agent-accounts/managed-account-display-names'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { CodexRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'
import { translate } from '@/i18n/i18n'
import {
  getCodexAccountDisplayDetail,
  getCodexAccountDisplayLabel
} from '../../../../../shared/agent-accounts/codex-account-display-label'
import {
  getCodexStatusRuntimeKey,
  getCodexStatusRuntimeLabel,
  getCodexStatusWslComparisonKey,
  getCodexStatusWslKey,
  type CodexStatusRuntimeTarget,
  type CodexStatusSwitchGroup,
  type StatusSwitchGroupOptions
} from './status-bar-runtime-targets'

type CodexStatusAccount = CodexRateLimitAccountsState['accounts'][number]

function getSingleConcreteCodexWslDistro(state: CodexRateLimitAccountsState): string | null {
  const distros = new Map<string, string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      distros.set(getCodexStatusWslComparisonKey(key), getCodexStatusWslKey(key))
    }
  }
  for (const account of state.accounts) {
    const key = getCodexStatusWslKey(account.wslDistro)
    if (account.managedHomeRuntime === 'wsl' && key !== '__default__') {
      const comparisonKey = getCodexStatusWslComparisonKey(key)
      if (!distros.has(comparisonKey)) {
        distros.set(comparisonKey, key)
      }
    }
  }
  return distros.size === 1 ? (Array.from(distros.values())[0] ?? null) : null
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
    return selection ? selection.host : (state.activeAccountId ?? null)
  }
  const distroKey = getCodexStatusWslComparisonKey(target.wslDistro)
  const distroSelection = Object.entries(selection?.wsl ?? {}).find(
    ([key]) => getCodexStatusWslComparisonKey(key) === distroKey
  )?.[1]
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
      getCodexStatusWslComparisonKey(account.wslDistro) ===
        getCodexStatusWslComparisonKey(target.wslDistro)
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
    const systemDefaultLabel = translate(
      'auto.components.status.bar.StatusBar.c676918adc',
      'System default'
    )
    return {
      key: getCodexStatusRuntimeKey(target),
      label: getCodexStatusRuntimeLabel(target, options.hostLabel),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: systemDefaultLabel,
          name: systemDefaultLabel,
          detail:
            target.runtime === 'host'
              ? [state.systemDefault?.email, state.systemDefault?.workspaceLabel]
                  .filter(Boolean)
                  .join('\n') || null
              : null,
          active: activeId === null,
          runtimeTarget: target
        },
        ...accountsForTarget.map((account) => ({
          id: account.id,
          label: getCodexAccountDisplayLabel(account, accountsForTarget, 'inline'),
          name: getManagedAccountPrimaryLabel(account),
          detail:
            [
              account.displayName ? account.email : null,
              getCodexAccountDisplayDetail(account, accountsForTarget)
            ]
              .filter(Boolean)
              .join(' · ') || null,
          active: account.id === activeId,
          runtimeTarget: target
        }))
      ]
    }
  }

  groups.push(makeGroup({ runtime: 'host', wslDistro: null }))

  const wslDistros = new Map<string, string>()
  const addWslDistro = (value: string | null | undefined) => {
    const display = getCodexStatusWslKey(value)
    const key = getCodexStatusWslComparisonKey(value)
    if (!wslDistros.has(key)) {
      wslDistros.set(key, display)
    }
  }
  for (const key of Object.keys(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    addWslDistro(key)
  }
  if (normalizedCurrentTarget.runtime === 'wsl') {
    addWslDistro(normalizedCurrentTarget.wslDistro)
  }
  for (const account of state.accounts) {
    if (account.managedHomeRuntime === 'wsl') {
      addWslDistro(account.wslDistro)
    }
  }
  if (options.includeFallbackWsl) {
    addWslDistro(options.fallbackWslDistro)
  }
  if (currentTarget.runtime === 'wsl' && currentTarget.wslDistro === null) {
    const concreteDistro = getSingleConcreteCodexWslDistro(state)
    if (concreteDistro) {
      wslDistros.delete('__default__')
    }
  }

  for (const [comparisonKey, displayKey] of Array.from(wslDistros).sort(([a], [b]) => {
    if (a === '__default__') {
      return -1
    }
    if (b === '__default__') {
      return 1
    }
    return a.localeCompare(b)
  })) {
    groups.push(
      makeGroup({
        runtime: 'wsl',
        wslDistro: comparisonKey === '__default__' ? null : displayKey
      })
    )
  }

  return groups
}

function withCodexDisplayName(
  settings: GlobalSettings,
  accountId: string
): { displayName?: string } {
  const displayName = getManagedAccountDisplayName(
    settings.managedAccountDisplayNames,
    'codex',
    accountId
  )
  return displayName ? { displayName } : {}
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
        ...withCodexDisplayName(settings, account.id),
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

/** `ownerEnvironmentId` is the server owning the shown accounts; `null` is this desktop. */
export function resolveCodexStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: CodexRateLimitAccountsState,
  ownerEnvironmentId: string | null
): CodexRateLimitAccountsState {
  if (ownerEnvironmentId) {
    return runtimeState
  }
  const local = getCodexStatusAccountsFromSettings(settings)
  return local ? { ...local, systemDefault: runtimeState.systemDefault } : runtimeState
}
