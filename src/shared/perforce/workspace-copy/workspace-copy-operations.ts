import type {
  PerforceStreamList,
  WorkspaceCopyListResult,
  WorkspaceCopyReadiness,
  WorkspaceCopyRemovalOptions,
  WorkspaceCopyRemovalPreview,
  WorkspaceCopyRemovalResult
} from './workspace-copy-types'

type NoParams = Record<never, never>

/** Making or removing a copy of a large workspace runs for minutes, so transports wait this long. */
export const PERFORCE_COPY_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

/**
 * The project-level copy operations of a Perforce folder project, by name: what each reads from its
 * request besides the project, and what it answers. Desktop IPC and the runtime's `perforce.*`
 * methods expose the same set.
 */
export type PerforceCopyOperations = {
  /** Whether this project's host can make copies (Windows, Dev Drive, free space, stream client). */
  copyReadiness: { params: NoParams; result: WorkspaceCopyReadiness }
  /** Streams in the workspace's depot, for the create-workspace stream picker. */
  listCopyStreams: { params: NoParams; result: PerforceStreamList }
  /** Marks a folder project inside a Perforce workspace as a Perforce project; true when it is one. */
  detectProject: { params: NoParams; result: boolean }
  /** Lists copies and brings the sidebar in line (adopts outside-made copies, drops vanished ones). */
  syncCopies: { params: NoParams; result: WorkspaceCopyListResult }
  previewCopyRemoval: { params: { name: string }; result: WorkspaceCopyRemovalPreview }
  removeCopy: {
    params: { name: string } & WorkspaceCopyRemovalOptions
    result: WorkspaceCopyRemovalResult
  }
}

export type PerforceCopyOperationName = keyof PerforceCopyOperations
export type PerforceCopyOperationParams<K extends PerforceCopyOperationName> =
  PerforceCopyOperations[K]['params']
export type PerforceCopyOperationResult<K extends PerforceCopyOperationName> =
  PerforceCopyOperations[K]['result']

const NAMES: Record<PerforceCopyOperationName, true> = {
  copyReadiness: true,
  listCopyStreams: true,
  detectProject: true,
  syncCopies: true,
  previewCopyRemoval: true,
  removeCopy: true
}

export function isPerforceCopyOperationName(value: unknown): value is PerforceCopyOperationName {
  return typeof value === 'string' && Object.hasOwn(NAMES, value)
}
