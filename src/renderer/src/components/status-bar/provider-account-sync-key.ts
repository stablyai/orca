import { sameProviderAccountData } from '@/runtime/observed-provider-accounts'
import type { ClaudeAccountSettings } from './status-bar-claude-accounts'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Cache by settings identity because Zustand reevaluates selectors on every store write and roster serialization is expensive.
const claudeKeyBySettings = new WeakMap<GlobalSettings, string>()
const codexKeyBySettings = new WeakMap<GlobalSettings, string>()

function memoizeSyncKey(
  cache: WeakMap<GlobalSettings, string>,
  settings: GlobalSettings | null | undefined,
  build: (settings: GlobalSettings) => string
): string {
  if (!settings) {
    return 'no-settings'
  }
  const cached = cache.get(settings)
  if (cached !== undefined) {
    return cached
  }
  const key = build(settings)
  cache.set(settings, key)
  return key
}

export function getClaudeAccountRosterSyncKey(settings: GlobalSettings | null | undefined): string {
  return memoizeSyncKey(
    claudeKeyBySettings,
    settings,
    (resolved) =>
      `${resolved.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeClaudeManagedAccountIdsByRuntime ?? null)}:${resolved.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  )
}

export function getClaudeAccountSyncKey(settings: GlobalSettings | null | undefined): string {
  return settings
    ? `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${getClaudeAccountRosterSyncKey(settings)}`
    : 'no-settings'
}

export function getCodexAccountSyncKey(settings: GlobalSettings | null | undefined): string {
  return memoizeSyncKey(
    codexKeyBySettings,
    settings,
    (resolved) =>
      `${resolved.activeRuntimeEnvironmentId?.trim() || 'local'}:${resolved.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeCodexManagedAccountIdsByRuntime ?? null)}:${resolved.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  )
}

const claudeProjectionBySettings = new WeakMap<GlobalSettings, ClaudeAccountSettings>()
let previousClaudeProjection: ClaudeAccountSettings | null = null

export function getClaudeAccountSettings(
  settings: GlobalSettings | null | undefined
): ClaudeAccountSettings | null {
  if (!settings) {
    return null
  }
  const cached = claudeProjectionBySettings.get(settings)
  if (cached) {
    return cached
  }
  const next: ClaudeAccountSettings = {
    claudeManagedAccounts: settings.claudeManagedAccounts,
    activeClaudeManagedAccountId: settings.activeClaudeManagedAccountId,
    activeClaudeManagedAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime
  }
  const stable =
    previousClaudeProjection !== null && sameProviderAccountData(previousClaudeProjection, next)
      ? previousClaudeProjection
      : next
  claudeProjectionBySettings.set(settings, stable)
  previousClaudeProjection = stable
  return stable
}
