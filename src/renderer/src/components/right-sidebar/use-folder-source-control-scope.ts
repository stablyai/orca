import type { Repo } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export function useFolderSourceControlScope(
  activeWorktreeId: string | null | undefined,
  activeRepo: Repo | null | undefined
): boolean {
  return (
    parseWorkspaceKey(activeWorktreeId ?? '')?.type === 'folder' ||
    Boolean(activeRepo && isFolderRepo(activeRepo))
  )
}
