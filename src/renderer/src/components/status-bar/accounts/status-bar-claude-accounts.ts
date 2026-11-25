import {
  getManagedAccountDisplayName,
  getManagedAccountInlineLabel
} from '../../../../../shared/agent-accounts/managed-account-display-names'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { resolveClaudeRuntimeSelection } from '../../../../../shared/claude-runtime-selection'
import {
  claudeAccountIdentityKey,
  claudeAccountDistroKey
} from '../../../../../shared/claude-account-identity'
import type { ClaudeRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'
import { translate } from '@/i18n/i18n'
import {
  getCodexStatusRuntimeKey,
  getCodexStatusRuntimeLabel,
  type ClaudeStatusSwitchGroup,
  type CodexStatusRuntimeTarget,
  type StatusSwitchGroupOptions
} from './status-bar-runtime-targets'

type ClaudeStatusAccount = ClaudeRateLimitAccountsState['accounts'][number]

export function getClaudeStatusRuntimeKey(target: CodexStatusRuntimeTarget): string {
  return target.runtime === 'host'
    ? getCodexStatusRuntimeKey(target)
    : `wsl:${claudeAccountDistroKey(target.wslDistro)}`
}

function accountIdentities(accounts: ClaudeStatusAccount[], activeId: string | null | undefined) {
  const identities = new Map<
    string,
    {
      selected?: ClaudeStatusAccount
      representative: ClaudeStatusAccount
      usable?: ClaudeStatusAccount
    }
  >()
  const prefer = (left: ClaudeStatusAccount, right: ClaudeStatusAccount) =>
    Number(!!left.runsOnSystemDefault) - Number(!!right.runsOnSystemDefault) ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
  for (const account of accounts) {
    const key = claudeAccountIdentityKey(account) ?? `record:${account.id}`
    const current = identities.get(key) ?? { representative: account }
    if (account.id === activeId) {
      current.selected = account
    }
    if (!account.needsSignIn && (!current.usable || prefer(account, current.usable) < 0)) {
      current.usable = account
    }
    if (prefer(account, current.representative) < 0) {
      current.representative = account
    }
    identities.set(key, current)
  }
  return [...identities.values()]
}

function getSingleConcreteClaudeWslDistro(state: ClaudeRateLimitAccountsState): string | null {
  const keys = new Set<string>()
  for (const [key, accountId] of Object.entries(state.activeAccountIdsByRuntime?.wsl ?? {})) {
    if (accountId && key !== '__default__') {
      keys.add(claudeAccountDistroKey(key))
    }
  }
  for (const account of state.accounts) {
    const key = claudeAccountDistroKey(account.wslDistro)
    if (account.managedAuthRuntime === 'wsl' && key !== '__default__') {
      keys.add(claudeAccountDistroKey(key))
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
): string | null | undefined {
  const result = resolveClaudeRuntimeSelection(
    {
      host: state.activeAccountIdsByRuntime?.host ?? state.activeAccountId ?? null,
      wsl: state.activeAccountIdsByRuntime?.wsl ?? {}
    },
    target
  )
  return result.kind === 'selected' ? result.accountId : undefined
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
      claudeAccountDistroKey(account.wslDistro) === claudeAccountDistroKey(target.wslDistro)
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
    const identities = accountIdentities(accountsForTarget, activeId)
    return {
      key: getClaudeStatusRuntimeKey(target),
      label: getCodexStatusRuntimeLabel(target, options.hostLabel),
      runtimeTarget: target,
      targets: [
        {
          id: null,
          label: translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'),
          active: activeId === null,
          runtimeTarget: target
        },
        ...identities.map(({ selected, representative, usable }) => {
          const account = selected ?? usable ?? representative
          const signedOut = !!account.needsSignIn
          const organization =
            account.organizationName?.trim() ||
            (account.organizationUuid?.trim()
              ? translate('accounts.claude.organizationSuffix', 'Organization ···{{suffix}}', {
                  suffix: account.organizationUuid.trim().slice(-4)
                })
              : translate('accounts.claude.personalOrganization', 'Personal'))
          return {
            id: account.id,
            usageAccountId: usable?.id ?? account.id,
            usableAccountId: usable?.id ?? null,
            label: getManagedAccountInlineLabel(account),
            active: selected !== undefined,
            runtimeTarget: target,
            detail: [
              signedOut
                ? translate('auto.components.status.bar.StatusBar.signedOutAccounts', 'Signed out')
                : null,
              organization,
              target.runtime === 'wsl' ? getCodexStatusRuntimeLabel(target) : null
            ]
              .filter(Boolean)
              .join(' · '),
            ...(signedOut
              ? {
                  disabled: true,
                  needsSignIn: true,
                  hint: translate(
                    'accounts.claude.signInRequired',
                    'Sign in again to use this account'
                  )
                }
              : {})
          }
        })
      ]
    }
  }

  groups.push(makeGroup({ runtime: 'host', wslDistro: null }))

  const wslKeys = new Set<string>(
    Object.keys(state.activeAccountIdsByRuntime?.wsl ?? {}).map(claudeAccountDistroKey)
  )
  if (normalizedCurrentTarget.runtime === 'wsl') {
    wslKeys.add(claudeAccountDistroKey(normalizedCurrentTarget.wslDistro))
  }
  for (const account of state.accounts) {
    if (account.managedAuthRuntime === 'wsl') {
      wslKeys.add(claudeAccountDistroKey(account.wslDistro))
    }
  }
  if (options.includeFallbackWsl) {
    wslKeys.add(claudeAccountDistroKey(options.fallbackWslDistro))
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
    const distro =
      currentTarget.wslDistro && claudeAccountDistroKey(currentTarget.wslDistro) === key
        ? currentTarget.wslDistro
        : key === '__default__'
          ? null
          : (state.accounts.find(
              (account) =>
                account.managedAuthRuntime === 'wsl' &&
                claudeAccountDistroKey(account.wslDistro) === key
            )?.wslDistro ?? key)
    groups.push(makeGroup({ runtime: 'wsl', wslDistro: distro }))
  }

  return groups
}

export type ClaudeAccountSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'activeClaudeManagedAccountId'
  | 'managedAccountDisplayNames'
>

function getClaudeStatusAccountsFromSettings(
  settings: ClaudeAccountSettings | null | undefined,
  runtimeState: ClaudeRateLimitAccountsState
): ClaudeRateLimitAccountsState | null {
  if (!settings) {
    return null
  }
  // Why: settings carry the fresh selection; host rows own what only the host reads (login, cover).
  const hostRows = new Map(runtimeState.accounts.map((account) => [account.id, account]))
  return {
    ...runtimeState,
    accounts: settings.claudeManagedAccounts
      .map((account): ClaudeStatusAccount => {
        // Settings carry the fresh name too; a retained host row may predate a rename.
        const displayName = getManagedAccountDisplayName(
          settings.managedAccountDisplayNames,
          'claude',
          account.id
        )
        const hostRow = hostRows.get(account.id)
        if (hostRow) {
          const { displayName: _hostName, ...rest } = hostRow
          return displayName ? { ...rest, displayName } : rest
        }
        return {
          id: account.id,
          email: account.email,
          ...(displayName ? { displayName } : {}),
          managedAuthRuntime: account.managedAuthRuntime ?? 'host',
          wslDistro: account.wslDistro ?? null,
          authMethod: account.authMethod ?? 'unknown',
          organizationUuid: account.organizationUuid ?? null,
          organizationName: account.organizationName ?? null,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
          lastAuthenticatedAt: account.lastAuthenticatedAt
        }
      })
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

// For remote ownership, desktop settings cannot override the owner’s account snapshot.

/** `ownerEnvironmentId` is the server owning the shown accounts; `null` is this desktop. */
export function resolveClaudeStatusAccountState(
  settings: ClaudeAccountSettings | null | undefined,
  runtimeState: ClaudeRateLimitAccountsState,
  ownerEnvironmentId: string | null
): ClaudeRateLimitAccountsState {
  if (ownerEnvironmentId) {
    return runtimeState
  }
  return getClaudeStatusAccountsFromSettings(settings, runtimeState) ?? runtimeState
}

export function signedInClaudeAccountCount(state: ClaudeRateLimitAccountsState): number {
  const identities = new Set(
    state.accounts
      .filter(
        (account) =>
          account.managedAuthRuntime !== 'wsl' &&
          !account.needsSignIn &&
          !account.runsOnSystemDefault
      )
      .map((account) => claudeAccountIdentityKey(account) ?? `record:${account.id}`)
  )
  const systemDefault = claudeAccountIdentityKey({
    email: state.systemDefaultEmail,
    organizationUuid: state.systemDefaultOrganizationUuid
  })
  if (systemDefault) {
    identities.add(systemDefault)
  }
  return identities.size
}
