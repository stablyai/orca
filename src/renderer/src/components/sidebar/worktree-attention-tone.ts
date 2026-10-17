import type { WorktreeStatus } from '@/lib/worktree-status'

/** Row tint for a sidebar workspace that needs the user. */
export type WorktreeAttentionTone = 'needs-you' | 'failed' | 'done'

export function getWorktreeAttentionTone(
  status: WorktreeStatus,
  isUnread: boolean
): WorktreeAttentionTone | null {
  if (status === 'permission') {
    return 'needs-you'
  }
  // Why: a running agent already shows its spinner, a read row is not news, and a live shell's
  // BEL can mark a row unread with no agent finish behind it.
  if (!isUnread || status === 'working' || status === 'monitoring' || status === 'active') {
    return null
  }
  return status === 'failed' ? 'failed' : 'done'
}
