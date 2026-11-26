import { useAppStore } from '@/store'
import type {
  WorktreeVisibilityDefaults,
  Repo
} from '../../../../../../shared/repository/repo-types'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/slices/worktrees/listing/worktree-visibility-defaults-by-host'

export function useRepoOwnerVisibilityDefaults(
  repo: Repo | null
): WorktreeVisibilityDefaults | undefined {
  const settings = useAppStore((state) => state.settings)
  const defaultsByHost = useAppStore((state) => state.worktreeVisibilityDefaultsByHost)
  return repo ? getRepoOwnerWorktreeVisibilityDefaults(repo, settings, defaultsByHost) : undefined
}
