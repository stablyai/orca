import type { NativeFileDropRejectedPayload } from './native-file-drop'

export const OS_FILE_DROP_OWNER_ATTRIBUTE = 'data-os-file-drop-owner'
// PR6 removes this release boundary together with legacy routing of unowned gaps.
export const OS_FILE_DROP_BOUNDARY_ATTRIBUTE = 'data-os-file-drop-boundary'

export type DroppedPathConsumer = 'agent' | 'main-reader'

export type PrepareDroppedPathsRequest = {
  paths: string[]
  consumer: DroppedPathConsumer
}

export type PreparedDroppedPaths = {
  paths: string[]
  failures: NativeFileDropRejectedPayload[]
}
