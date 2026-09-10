import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why memoized on settings identity: these run inside useAppStore selectors, which Zustand re-runs
// on every store write. Building the key stringifies a map and joins the whole managed-account
// roster, and its inputs only move when `settings` is replaced.
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
