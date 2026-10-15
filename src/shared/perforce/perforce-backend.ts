import type { GitDiffResult } from '../git-diff-compare-types'
import { detectPerforceWorkspace } from './perforce-detection'
import {
  createChangelistWithFiles,
  deleteChangelistWithFiles,
  deleteEmptyChangelist,
  shelveAndRevertFiles,
  unshelveFiles,
  deleteShelf,
  editChangelistDescription,
  unshelveFrom,
  moveFilesToChangelist,
  shelveChangelist,
  unshelveChangelist
} from './perforce-changelists'
import {
  checkoutIfReadOnly,
  isReadOnlyWorkspaceFile,
  closeFilesKeepingContent,
  discardFiles,
  editFiles,
  reconcileFiles,
  submitChangelist,
  submitDefaultChangelist,
  syncLatest
} from './perforce-mutations'
import {
  getPerforceDiff,
  getPerforceDiffText,
  getPerforceHistory,
  getPerforceInfo,
  getPerforceStatus
} from './perforce-status'
import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from './perforce-types'
import { invalidateWorkspaceScan } from './perforce-workspace-scan'

type Cwd = string
type Files = readonly string[]
type Target = 'default' | number

/** Every Perforce operation, executed where `cwd` lives: the local machine or an SSH relay. */
export type PerforceBackend = {
  detect: (cwd: Cwd) => Promise<PerforceDetectResult>
  status: (cwd: Cwd) => Promise<PerforceStatusResult>
  history: (cwd: Cwd, limit: number) => Promise<PerforceHistoryEntry[]>
  diff: (cwd: Cwd, filePath: string) => Promise<GitDiffResult>
  open: (cwd: Cwd, filePaths: Files) => Promise<PerforceOperationResult>
  close: (cwd: Cwd, filePaths: Files) => Promise<PerforceOperationResult>
  /** `p4 edit`: opens files for edit even when they are unchanged (unlike `open`, which reconciles). */
  edit: (cwd: Cwd, filePaths: Files) => Promise<PerforceOperationResult>
  discard: (
    cwd: Cwd,
    entries: readonly Pick<PerforceEntry, 'path' | 'group' | 'action'>[]
  ) => Promise<PerforceOperationResult>
  submit: (cwd: Cwd, changelist: Target, message?: string) => Promise<PerforceOperationResult>
  sync: (cwd: Cwd) => Promise<PerforceOperationResult>
  shelve: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  unshelve: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  deleteShelf: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  shelveAndRevertFiles: (
    cwd: Cwd,
    changelist: number,
    filePaths: Files
  ) => Promise<PerforceOperationResult>
  unshelveFiles: (
    cwd: Cwd,
    changelist: number,
    depotPaths: Files
  ) => Promise<PerforceOperationResult>
  unshelveFrom: (cwd: Cwd, source: number, target: Target) => Promise<PerforceOperationResult>
  createChangelist: (
    cwd: Cwd,
    description: string,
    filePaths: Files
  ) => Promise<PerforceOperationResult & { changelist?: number }>
  editDescription: (
    cwd: Cwd,
    changelist: number,
    description: string
  ) => Promise<PerforceOperationResult>
  moveToChangelist: (
    cwd: Cwd,
    filePaths: Files,
    changelist: Target
  ) => Promise<PerforceOperationResult>
  deleteChangelist: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  deleteChangelistWithFiles: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  checkoutIfReadOnly: (cwd: Cwd, filePath: string) => Promise<void>
  isReadOnlyFile: (cwd: Cwd, filePath: string) => Promise<boolean>
  diffText: (cwd: Cwd, filePaths: Files) => Promise<string>
  info: (cwd: Cwd) => ReturnType<typeof getPerforceInfo>
}

/** The operation changes which files are opened or what is on disk: the next status rescans. */
function rescansAfter<A extends unknown[], R>(
  operation: (cwd: Cwd, ...args: A) => Promise<R>
): (cwd: Cwd, ...args: A) => Promise<R> {
  return async (cwd, ...args) => {
    try {
      return await operation(cwd, ...args)
    } finally {
      invalidateWorkspaceScan(cwd)
    }
  }
}

export const localPerforceBackend: PerforceBackend = {
  detect: detectPerforceWorkspace,
  status: getPerforceStatus,
  history: getPerforceHistory,
  diff: getPerforceDiff,
  open: rescansAfter((cwd, filePaths: Files) => reconcileFiles(cwd, filePaths)),
  close: rescansAfter(closeFilesKeepingContent),
  edit: rescansAfter(editFiles),
  discard: rescansAfter(discardFiles),
  submit: rescansAfter((cwd, changelist: Target, message?: string) =>
    changelist === 'default'
      ? submitDefaultChangelist(cwd, message ?? '')
      : submitChangelist(cwd, changelist)
  ),
  sync: rescansAfter(syncLatest),
  shelve: shelveChangelist,
  unshelve: rescansAfter(unshelveChangelist),
  deleteShelf,
  unshelveFiles: rescansAfter(unshelveFiles),
  shelveAndRevertFiles: rescansAfter(shelveAndRevertFiles),
  unshelveFrom: rescansAfter(unshelveFrom),
  createChangelist: createChangelistWithFiles,
  editDescription: editChangelistDescription,
  moveToChangelist: moveFilesToChangelist,
  deleteChangelist: deleteEmptyChangelist,
  deleteChangelistWithFiles: rescansAfter(deleteChangelistWithFiles),
  checkoutIfReadOnly: rescansAfter(checkoutIfReadOnly),
  isReadOnlyFile: isReadOnlyWorkspaceFile,
  diffText: getPerforceDiffText,
  info: getPerforceInfo
}
