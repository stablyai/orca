import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export function getCodexStatusAccountsFromSettings(
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

export function getClaudeStatusAccountsFromSettings(
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

export function resolveCodexStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: CodexRateLimitAccountsState
): CodexRateLimitAccountsState {
  // Why: remote server snapshots own their account roster; desktop settings describe another host.
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getCodexStatusAccountsFromSettings(settings) ?? runtimeState
}

export function resolveClaudeStatusAccountState(
  settings: GlobalSettings | null | undefined,
  runtimeState: ClaudeRateLimitAccountsState
): ClaudeRateLimitAccountsState {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return runtimeState
  }
  return getClaudeStatusAccountsFromSettings(settings) ?? runtimeState
}
