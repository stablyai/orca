import type {
  ClaudeManagedAccountRuntimeSelection,
  ClaudeRateLimitAccountsState,
  CodexManagedAccountRuntimeSelection,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'

type ProviderAccount =
  | ClaudeRateLimitAccountsState['accounts'][number]
  | CodexRateLimitAccountsState['accounts'][number]

type ProviderAccountSelection = {
  activeAccountId: string | null
  activeAccountIdsByRuntime?:
    | ClaudeManagedAccountRuntimeSelection
    | CodexManagedAccountRuntimeSelection
}

export type ProviderAccountRuntimeView = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

// Share the WSL default sentinel between distro selection and active-account resolution.
export const WSL_DEFAULT_DISTRO_KEY = '__default__'

export function getProviderAccountRuntime(account: ProviderAccount): {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
} {
  const runtime =
    'authMethod' in account
      ? (account.managedAuthRuntime ?? 'host')
      : (account.managedHomeRuntime ?? 'host')
  return {
    runtime,
    wslDistro: account.wslDistro ?? null
  }
}

export function getProviderAccountActiveIdForView(
  selection: ProviderAccountSelection,
  runtime: ProviderAccountRuntimeView
): string | null {
  if (runtime.runtime === 'host') {
    return selection.activeAccountIdsByRuntime?.host ?? selection.activeAccountId ?? null
  }
  if (runtime.wslDistro) {
    return selection.activeAccountIdsByRuntime?.wsl?.[runtime.wslDistro] ?? null
  }
  const wsl = selection.activeAccountIdsByRuntime?.wsl ?? {}
  if (wsl[WSL_DEFAULT_DISTRO_KEY]) {
    return wsl[WSL_DEFAULT_DISTRO_KEY]
  }
  const selectedIds = Array.from(new Set(Object.values(wsl).filter(Boolean)))
  return selectedIds.length === 1 ? selectedIds[0] : null
}

export function providerAccountMatchesView(
  account: ProviderAccount,
  runtime: ProviderAccountRuntimeView,
  options: {
    remoteOwner: boolean
    ownerPlatform: NodeJS.Platform | null
  }
): boolean {
  const accountView = getProviderAccountRuntime(account)

  if (options.remoteOwner) {
    // Account rosters belong to the runtime owner; Windows runtimes own both host and WSL slots.
    return options.ownerPlatform === 'win32' || accountView.runtime !== 'wsl'
  }
  if (runtime.runtime === 'host') {
    return accountView.runtime !== 'wsl'
  }
  if (accountView.runtime !== 'wsl') {
    return false
  }
  return runtime.wslDistro ? accountView.wslDistro === runtime.wslDistro : true
}

export function providerAccountIsActiveInView(
  account: ProviderAccount,
  selection: ProviderAccountSelection,
  runtime: ProviderAccountRuntimeView,
  options: {
    remoteOwner: boolean
  }
): boolean {
  if (options.remoteOwner) {
    // Remote Windows combines slots; resolve Active from each account’s runtime rather than host-view filtering.
    return (
      getProviderAccountActiveIdForView(selection, getProviderAccountRuntime(account)) ===
      account.id
    )
  }
  return getProviderAccountActiveIdForView(selection, runtime) === account.id
}
