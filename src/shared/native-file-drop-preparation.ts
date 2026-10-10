import type { NativeFileDropRejectedPayload } from './native-file-drop'

export const OS_FILE_DROP_OWNER_ATTRIBUTE = 'data-os-file-drop-owner'

export type DroppedPathConsumer = 'agent' | 'main-reader'

export type PrepareDroppedPathsRequest = {
  paths: string[]
  consumer: DroppedPathConsumer
}

export type PreparedDroppedPaths = {
  paths: string[]
  failures: NativeFileDropRejectedPayload[]
}
