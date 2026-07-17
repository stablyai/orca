import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { useAppStore } from '@/store'
import type { WebAiAccount } from '../../../shared/types'
import { normalizeWebAiAccounts } from '../../../shared/web-ai-accounts'
import { activateAndRevealWorktree } from './worktree-activation'

export type WorkspaceNumberShortcutTarget = { kind: 'worktree'; worktreeId: string }

const webAiAccountLaunchesInFlight = new Set<string>()

export function resolveWorkspaceNumberShortcutTarget(
  visibleWorktreeIds: readonly string[],
  index: number
): WorkspaceNumberShortcutTarget | null {
  if (!Number.isInteger(index) || index < 0) {
    return null
  }

  const worktreeId = visibleWorktreeIds[index]
  return worktreeId ? { kind: 'worktree', worktreeId } : null
}

export function resolveWebAiAccountNumberShortcutTarget(
  accountsValue: unknown,
  index: number
): WebAiAccount | null {
  if (!Number.isInteger(index) || index < 0) {
    return null
  }
  return normalizeWebAiAccounts(accountsValue)[index] ?? null
}

export async function activateWorkspaceNumberShortcut(index: number): Promise<boolean> {
  const target = resolveWorkspaceNumberShortcutTarget(getVisibleWorktreeIds(), index)
  if (!target) {
    return false
  }

  return activateAndRevealWorktree(target.worktreeId) !== false
}

export async function activateWebAiAccountNumberShortcut(index: number): Promise<boolean> {
  const store = useAppStore.getState()
  const account = resolveWebAiAccountNumberShortcutTarget(store.settings?.webAiAccounts, index)
  if (!account || webAiAccountLaunchesInFlight.has(account.id)) {
    return false
  }

  // Why: account launch validates the persisted browser profile asynchronously.
  // Collapse duplicate key events until it settles so one held shortcut cannot
  // create multiple workspaces/tabs for the same account.
  webAiAccountLaunchesInFlight.add(account.id)
  try {
    return (await store.launchWebAiAccount(account)).ok
  } finally {
    webAiAccountLaunchesInFlight.delete(account.id)
  }
}
