import { isFolderRepo } from '../../../../../shared/repo-kind'
import type { Repo } from '../../../../../shared/repo-types'
import { usePerforceOpenedForEdit } from './perforce-opened-files'
import { usePerforceSettings } from './use-perforce-settings'
import { usePerforceWorkspace } from './use-perforce-workspace'

/** True when an editor tab's file is opened for edit in a Perforce workspace (shown as an "E" prefix). */
export function usePerforceEditedTab(
  file: { mode: string; relativePath: string; isDirty: boolean },
  worktreePath: string | null,
  repo: Repo | null | undefined
): boolean {
  const settings = usePerforceSettings()
  const { isPerforce } = usePerforceWorkspace(
    worktreePath,
    repo?.connectionId,
    file.mode === 'edit' && Boolean(repo && isFolderRepo(repo))
  )
  return usePerforceOpenedForEdit(
    worktreePath,
    repo?.connectionId,
    file.relativePath.replaceAll('\\', '/'),
    isPerforce && settings.showEditedTabPrefix,
    file.isDirty,
    settings.refreshIntervalSeconds
  )
}
