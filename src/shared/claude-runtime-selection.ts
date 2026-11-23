import type { ClaudeManagedAccountRuntimeSelection } from './agent-accounts/managed-account-types'
import { claudeAccountDistroKey } from './claude-account-identity'

type ClaudeSelection = { kind: 'selected'; accountId: string | null } | { kind: 'conflict' }

/** Exact saved spelling wins; ambiguous aliases are distinct from System default. */
export function resolveClaudeRuntimeSelection(
  selection: ClaudeManagedAccountRuntimeSelection,
  target: { runtime: 'host' | 'wsl'; wslDistro: string | null }
): ClaudeSelection {
  const distro = target.wslDistro?.trim() || null
  if (target.runtime === 'host') {
    return { kind: 'selected', accountId: selection.host }
  }
  if (distro) {
    if (Object.hasOwn(selection.wsl, distro)) {
      return { kind: 'selected', accountId: selection.wsl[distro] ?? null }
    }
    const ids = new Set(
      Object.entries(selection.wsl)
        .filter(([key]) => claudeAccountDistroKey(key) === claudeAccountDistroKey(distro))
        .map(([, id]) => id)
    )
    return ids.size > 1
      ? { kind: 'conflict' }
      : { kind: 'selected', accountId: ids.values().next().value ?? null }
  }
  const ids = new Set(Object.values(selection.wsl).filter(Boolean))
  const defaultId = selection.wsl.__default__
  return defaultId || ids.size <= 1
    ? { kind: 'selected', accountId: defaultId ?? ids.values().next().value ?? null }
    : { kind: 'conflict' }
}
