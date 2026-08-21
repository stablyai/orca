import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'

export const MCODE_WORKTREE_FILE_CHANGE_EVENT = 'mcode:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}
