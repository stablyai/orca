import type { GitDiffResult } from '../git-diff-compare-types'
import { detectPerforceWorkspace } from './perforce-detection'
import {
  createChangelistWithFiles,
  deleteEmptyChangelist,
  deleteShelf,
  editChangelistDescription,
  moveFilesToChangelist,
  shelveChangelist,
  unshelveChangelist
} from './perforce-changelists'
import {
  checkoutIfReadOnly,
  closeFilesKeepingContent,
  discardFiles,
  reconcileFiles,
  submitChangelist,
  submitDefaultChangelist,
  syncLatest
} from './perforce-mutations'
import { getPerforceDiff, getPerforceHistory, getPerforceStatus } from './perforce-status'
import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from './perforce-types'

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
  discard: (
    cwd: Cwd,
    entries: readonly Pick<PerforceEntry, 'path' | 'group' | 'action'>[]
  ) => Promise<PerforceOperationResult>
  submit: (cwd: Cwd, changelist: Target, message?: string) => Promise<PerforceOperationResult>
  sync: (cwd: Cwd) => Promise<PerforceOperationResult>
  shelve: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  unshelve: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
  deleteShelf: (cwd: Cwd, changelist: number) => Promise<PerforceOperationResult>
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
  checkoutIfReadOnly: (cwd: Cwd, filePath: string) => Promise<void>
}

export const localPerforceBackend: PerforceBackend = {
  detect: detectPerforceWorkspace,
  status: getPerforceStatus,
  history: getPerforceHistory,
  diff: getPerforceDiff,
  open: (cwd, filePaths) => reconcileFiles(cwd, filePaths),
  close: closeFilesKeepingContent,
  discard: discardFiles,
  submit: (cwd, changelist, message) =>
    changelist === 'default'
      ? submitDefaultChangelist(cwd, message ?? '')
      : submitChangelist(cwd, changelist),
  sync: syncLatest,
  shelve: shelveChangelist,
  unshelve: unshelveChangelist,
  deleteShelf,
  createChangelist: createChangelistWithFiles,
  editDescription: editChangelistDescription,
  moveToChangelist: moveFilesToChangelist,
  deleteChangelist: deleteEmptyChangelist,
  checkoutIfReadOnly
}
