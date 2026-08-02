import type { FsChangedPayload } from '../../../shared/types'

export const ORCA_WORKTREE_FILE_CHANGE_EVENT = 'orca:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}
