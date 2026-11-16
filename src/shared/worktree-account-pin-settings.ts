import type { ClaudeManagedAccount, CodexManagedAccount } from './managed-account-types'

export type WorktreeAccountPinSettings = {
  /** Worker accounts (#9496): a worktree pinned to an account launches Claude there whatever the selection; worktreeId → accountId. */
  claudeAccountPinsByWorktree?: Record<string, string>
  /** The same for Codex: its launches in that worktree use the account's own CODEX_HOME. */
  codexAccountPinsByWorktree?: Record<string, string>
}

export type PinnableAgent = 'claude' | 'codex'

/** The account an agent's host launches in this workspace are pinned to; pins never cover WSL. */
export function workspacePinnedAccount(
  settings: WorktreeAccountPinSettings,
  agent: string,
  location: { workspaceId: string; wslDistro: string | null }
): string | undefined {
  if (location.wslDistro !== null) {
    return undefined
  }
  const pins =
    agent === 'claude'
      ? settings.claudeAccountPinsByWorktree
      : agent === 'codex'
        ? settings.codexAccountPinsByWorktree
        : undefined
  return pins?.[location.workspaceId]
}

/** The accounts chosen for each agent when a worktree is created; agentId → accountId. */
export type WorktreeAccountPins = Partial<Record<PinnableAgent, string>>

export const ACCOUNT_PIN_SETTING = {
  claude: 'claudeAccountPinsByWorktree',
  codex: 'codexAccountPinsByWorktree'
} as const

// Only what pinning reads, so callers and tests need not build whole accounts.
type PinnableAccount = Pick<ClaudeManagedAccount, 'id' | 'email' | 'managedAuthRuntime'> &
  Pick<CodexManagedAccount, 'managedHomeRuntime'>
type ManagedAccounts = {
  claudeManagedAccounts?: Pick<ClaudeManagedAccount, 'id' | 'email' | 'managedAuthRuntime'>[]
  codexManagedAccounts?: Pick<CodexManagedAccount, 'id' | 'email' | 'managedHomeRuntime'>[]
}

/** Pins cover host launches only, so WSL accounts are not offered. */
export function pinnableHostAccounts(
  settings: ManagedAccounts,
  agent: PinnableAgent
): Pick<PinnableAccount, 'id' | 'email'>[] {
  return agent === 'claude'
    ? (settings.claudeManagedAccounts ?? []).filter(
        (account) => account.managedAuthRuntime !== 'wsl'
      )
    : (settings.codexManagedAccounts ?? []).filter(
        (account) => account.managedHomeRuntime !== 'wsl'
      )
}

/**
 * Settings that pin a new worktree to the accounts chosen at creation, before its agent starts.
 * An account removed meanwhile is skipped, so the worktree follows the selection instead.
 */
export function createdWorktreeAccountPinPatch(
  settings: ManagedAccounts & WorktreeAccountPinSettings,
  worktreeId: string,
  pins: WorktreeAccountPins | undefined
): WorktreeAccountPinSettings | null {
  const patch: WorktreeAccountPinSettings = {}
  for (const agent of ['claude', 'codex'] as const) {
    const accountId = pins?.[agent]
    if (!accountId || !pinnableHostAccounts(settings, agent).some((a) => a.id === accountId)) {
      continue
    }
    patch[ACCOUNT_PIN_SETTING[agent]] = {
      ...settings[ACCOUNT_PIN_SETTING[agent]],
      [worktreeId]: accountId
    }
  }
  return Object.keys(patch).length ? patch : null
}
