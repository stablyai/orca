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

// Why: a switch-back catch-up is synthesized in the renderer, so consumers on the raw IPC bus never see it.
const catchUpPayloads = new WeakSet<FsChangedPayload>()

export function markWorktreeCatchUpPayload(payload: FsChangedPayload): FsChangedPayload {
  catchUpPayloads.add(payload)
  return payload
}

export function isWorktreeCatchUpPayload(payload: FsChangedPayload): boolean {
  return catchUpPayloads.has(payload)
}
