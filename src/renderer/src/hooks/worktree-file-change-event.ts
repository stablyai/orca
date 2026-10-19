import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'

export const ORCA_WORKTREE_FILE_CHANGE_EVENT = 'orca:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- WindowEventMap requires declaration merging.
  interface WindowEventMap {
    'orca:worktree-file-change': CustomEvent<WorktreeFileChangeEventDetail>
  }
}
