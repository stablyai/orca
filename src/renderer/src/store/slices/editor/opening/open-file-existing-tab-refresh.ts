import type { OpenFile } from '../types/open-file'
import type { OpenFileOptions } from '../types/editor-files-slice'
import { shouldRequestExistingFileContentReload } from '../file-ids/editor-file-ids'

/** The re-opened tab with the requested file shape, or null when the existing tab already matches. */
export function refreshExistingOpenFile(args: {
  existing: OpenFile
  file: Omit<OpenFile, 'id' | 'isDirty'>
  options: OpenFileOptions | undefined
  isPreview: boolean
  runtimeEnvironmentId: OpenFile['runtimeEnvironmentId']
  operationProvenance: OpenFile['operationProvenance']
}): OpenFile | null {
  const { existing, file, options, runtimeEnvironmentId, operationProvenance } = args
  const updatedPreview = args.isPreview ? existing.isPreview : false
  const nextExternalSshTargetId = file.externalSshTargetId ?? existing.externalSshTargetId
  const refreshExternalSshProvenance = file.externalSshTargetId !== undefined
  const nextOperationProvenance = refreshExternalSshProvenance
    ? operationProvenance
    : (existing.operationProvenance ?? operationProvenance)
  // Why: a re-click mints a fresh grant; the old one may have expired.
  const nextGrantId = file.terminalArtifactGrantId ?? existing.terminalArtifactGrantId
  const fileContentReloadNonce = shouldRequestExistingFileContentReload(
    existing,
    file.mode,
    options
  )
    ? (existing.fileContentReloadNonce ?? 0) + 1
    : existing.fileContentReloadNonce
  // Normal open explicitly enables editing of a View Log; View Log must never downgrade an already writable tab.
  const nextReadOnly = existing.readOnly === true && file.readOnly === true ? true : undefined
  const nextLiveTail = file.liveTail === true && nextReadOnly === true ? true : undefined
  const needsExistingUpdate =
    existing.mode !== file.mode ||
    existing.diffSource !== file.diffSource ||
    existing.branchCompare?.compareVersion !== file.branchCompare?.compareVersion ||
    existing.commitCompare?.compareVersion !== file.commitCompare?.compareVersion ||
    existing.conflict?.kind !== file.conflict?.kind ||
    existing.conflict?.conflictKind !== file.conflict?.conflictKind ||
    existing.conflict?.conflictStatus !== file.conflict?.conflictStatus ||
    existing.conflictReview?.snapshotTimestamp !== file.conflictReview?.snapshotTimestamp ||
    existing.isPreview !== updatedPreview ||
    existing.language !== file.language ||
    existing.relativePath !== file.relativePath ||
    existing.worktreeId !== file.worktreeId ||
    existing.runtimeEnvironmentId !== runtimeEnvironmentId ||
    existing.externalSshTargetId !== nextExternalSshTargetId ||
    existing.terminalArtifactGrantId !== nextGrantId ||
    refreshExternalSshProvenance ||
    existing.operationProvenance !== nextOperationProvenance ||
    existing.fileContentReloadNonce !== fileContentReloadNonce ||
    existing.readOnly !== nextReadOnly ||
    existing.liveTail !== nextLiveTail
  if (!needsExistingUpdate) {
    return null
  }
  return {
    ...existing,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    language: file.language,
    runtimeEnvironmentId,
    externalSshTargetId: nextExternalSshTargetId,
    terminalArtifactGrantId: nextGrantId,
    operationProvenance: nextOperationProvenance,
    mode: file.mode,
    diffSource: file.diffSource,
    branchCompare: file.branchCompare,
    commitCompare: file.commitCompare,
    branchOldPath: file.branchOldPath,
    combinedAlternate: file.combinedAlternate,
    combinedAreaFilter: file.combinedAreaFilter,
    commitEntriesSnapshot: file.commitEntriesSnapshot,
    conflict: file.conflict,
    skippedConflicts: file.skippedConflicts,
    conflictReview: file.conflictReview,
    isPreview: updatedPreview,
    fileContentReloadNonce,
    readOnly: nextReadOnly,
    liveTail: nextLiveTail
  }
}
