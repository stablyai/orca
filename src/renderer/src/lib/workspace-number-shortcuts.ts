import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { useAppStore } from '@/store'
import type { WebAiAccount } from '../../../shared/types'
import { normalizeWebAiAccounts } from '../../../shared/web-ai-accounts'
import { activateAndRevealWorktree } from './worktree-activation'

export type WorkspaceNumberShortcutTarget =
  | { kind: 'web-ai-account'; account: WebAiAccount }
  | { kind: 'worktree'; worktreeId: string }

export function resolveWorkspaceNumberShortcutTarget(
  accountsValue: unknown,
  visibleWorktreeIds: readonly string[],
  index: number
): WorkspaceNumberShortcutTarget | null {
  if (!Number.isInteger(index) || index < 0) {
    return null
  }

  const accounts = normalizeWebAiAccounts(accountsValue)
  const account = accounts[index]
  if (account) {
    return { kind: 'web-ai-account', account }
  }

  const worktreeId = visibleWorktreeIds[index - accounts.length]
  return worktreeId ? { kind: 'worktree', worktreeId } : null
}

export async function activateWorkspaceNumberShortcut(index: number): Promise<boolean> {
  const store = useAppStore.getState()
  const target = resolveWorkspaceNumberShortcutTarget(
    store.settings?.webAiAccounts,
    getVisibleWorktreeIds(),
    index
  )
  if (!target) {
    return false
  }

  if (target.kind === 'web-ai-account') {
    // Why: number shortcuts must use the same authoritative profile check as
    // sidebar launches so a deleted profile cannot recreate a stale partition.
    return (await store.launchWebAiAccount(target.account)).ok
  }

  return activateAndRevealWorktree(target.worktreeId) !== false
}
