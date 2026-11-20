import type { ClaudeAccountSettings } from './status-bar-claude-accounts'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameProviderAccountData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameProviderAccountData(item, right[index]))
    )
  }
  if (!record(left) || !record(right)) {
    return false
  }
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameProviderAccountData(left[key], right[key]))
  )
}

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
      `${resolved.activeClaudeManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeClaudeManagedAccountIdsByRuntime ?? null)}:${resolved.claudeManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}:${JSON.stringify(resolved.managedAccountDisplayNames?.claude ?? null)}`
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
      `${resolved.activeRuntimeEnvironmentId?.trim() || 'local'}:${resolved.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(resolved.activeCodexManagedAccountIdsByRuntime ?? null)}:${resolved.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}:${JSON.stringify(resolved.managedAccountDisplayNames?.codex ?? null)}`
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
    activeClaudeManagedAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime,
    // Only Claude's names, so a Codex rename leaves Claude consumers untouched.
    managedAccountDisplayNames: { claude: settings.managedAccountDisplayNames?.claude }
  }
  const stable =
    previousClaudeProjection !== null && sameProviderAccountData(previousClaudeProjection, next)
      ? previousClaudeProjection
      : next
  claudeProjectionBySettings.set(settings, stable)
  previousClaudeProjection = stable
  return stable
}
