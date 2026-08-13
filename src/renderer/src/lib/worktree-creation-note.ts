import { useAppStore } from '@/store'
import type { Worktree } from '../../../shared/types'

export async function persistCreatedWorktreeNote(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  note: string
): Promise<void> {
  try {
    await useAppStore
      .getState()
      .updateWorktreeMeta(
        worktree.id,
        { comment: note },
        worktree.hostId ? { executionHostId: worktree.hostId } : undefined
      )
  } catch {
    console.error('Failed to update worktree meta after creation')
  }
}
