import { useRepoById } from '@/store/selectors'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

/**
 * The emoji to spin as a workspace's working indicator, or null when its icon
 * is not an emoji (Lucide/image/default icons keep the generic ring spinner).
 */
export function useWorktreeWorkingEmoji(worktreeId: string): string | null {
  const repo = useRepoById(getRepoIdFromWorktreeId(worktreeId))
  return repo?.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : null
}
