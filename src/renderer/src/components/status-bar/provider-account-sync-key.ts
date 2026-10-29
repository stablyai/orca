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

export function getClaudeAccountSyncKey(settings: GlobalSettings | null | undefined): string {
  return memoizeSyncKey(
    claudeKeyBySettings,
    settings,
    (resolved) =>
      `${resolved.activeRuntimeEnvironmentId?.trim() || 'local'}:${resolved.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeClaudeManagedAccountIdsByRuntime ?? null)}:${resolved.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  )
}

export function getCodexAccountSyncKey(settings: GlobalSettings | null | undefined): string {
  return memoizeSyncKey(
    codexKeyBySettings,
    settings,
    (resolved) =>
      `${resolved.activeRuntimeEnvironmentId?.trim() || 'local'}:${resolved.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeCodexManagedAccountIdsByRuntime ?? null)}:${resolved.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
  )
}
