import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'
import type { OpenFile } from '../store/slices/editor'
import { editorDocumentIdentityKey } from '../store/slices/editor/file-ids/editor-document-identity'

export type PersistedEditorFileRecords = {
  openFilesByWorktree: Record<string, PersistedOpenFile[]>
  /** Ids of the live OpenFiles that own a persisted record, per worktree. */
  editFileIdsByWorktree: Record<string, Set<string>>
  /** Merged-away OpenFile id → the id whose record replaced it. */
  survivingFileIdByMergedId: Map<string, string>
}

function toPersistedOpenFile(
  file: OpenFile,
  editorDrafts: Record<string, string>
): PersistedOpenFile {
  // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
  const dirtyDraftContent =
    file.isDirty && file.readOnly !== true ? editorDrafts[file.id] : undefined
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    language: file.language,
    isPreview: file.isPreview || undefined,
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    // Why: persist readOnly only when true; absence is the writable default on restore.
    ...(file.readOnly === true ? { readOnly: true } : {}),
    ...(file.readOnly === true && file.liveTail === true ? { liveTail: true } : {}),
    ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
    // Why: baseline travels with the draft so restore can detect a changed-on-disk conflict before autosave clobbers an offline agent write.
    ...(dirtyDraftContent !== undefined && file.lastKnownDiskSignature
      ? { lastKnownDiskSignature: file.lastKnownDiskSignature }
      : {})
  }
}

/** A record already written to the worktree's row list, and the live OpenFile that owns it. */
type KeptRecord = { record: PersistedOpenFile; fileId: string; position: number }

/** Two unsaved buffers that disagree: merging would silently destroy one of them. */
function hasDivergentDraft(left: PersistedOpenFile, right: PersistedOpenFile): boolean {
  return (
    left.dirtyDraftContent !== undefined &&
    right.dirtyDraftContent !== undefined &&
    left.dirtyDraftContent !== right.dirtyDraftContent
  )
}

/**
 * Why: merging drops the candidate's row, so a baseline it alone carries would be lost. The drafts
 * are the same text, so the candidate's baseline describes the kept record's document too.
 */
function withCarriedDiskBaseline(
  kept: PersistedOpenFile,
  candidate: PersistedOpenFile
): PersistedOpenFile | null {
  if (
    kept.dirtyDraftContent === undefined ||
    kept.dirtyDraftContent !== candidate.dirtyDraftContent ||
    kept.lastKnownDiskSignature !== undefined ||
    candidate.lastKnownDiskSignature === undefined
  ) {
    return null
  }
  return { ...kept, lastKnownDiskSignature: candidate.lastKnownDiskSignature }
}

function winsOverKeptRecord(
  candidate: { record: PersistedOpenFile; fileId: string },
  kept: { record: PersistedOpenFile; fileId: string },
  activeFileId: string | null | undefined
): boolean {
  if (kept.record.dirtyDraftContent !== undefined) {
    return false
  }
  if (candidate.record.dirtyDraftContent !== undefined) {
    return true
  }
  // Why before the active-file rule: a preview record restores a tab the next single click replaces.
  if (kept.record.isPreview !== candidate.record.isPreview) {
    return kept.record.isPreview === true
  }
  return candidate.fileId === activeFileId && kept.fileId !== activeFileId
}

function resolveSurvivingFileId(merged: Map<string, string>, fileId: string): string {
  let current = fileId
  const seen = new Set<string>([fileId])
  let next = merged.get(current)
  while (next !== undefined && !seen.has(next)) {
    seen.add(next)
    current = next
    next = merged.get(current)
  }
  return current
}

/** Serialize the edit-mode documents, collapsing records that cannot be told apart on restore. */
export function buildPersistedEditorFileRecords(
  openFiles: readonly OpenFile[],
  editorDrafts: Record<string, string>,
  activeFileIdByWorktree: Record<string, string | null>
): PersistedEditorFileRecords {
  const openFilesByWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  const survivingFileIdByMergedId = new Map<string, string>()
  // Why a list per identity: divergent drafts stay apart as separate rows, and a later duplicate
  // must merge into whichever of them it agrees with — tracking only the first stacks a new row
  // for every repeat of the second draft.
  const keptVariantsByIdentity = new Map<string, KeptRecord[]>()

  for (const file of openFiles) {
    if (file.mode !== 'edit') {
      continue
    }
    const records =
      openFilesByWorktree[file.worktreeId] ?? (openFilesByWorktree[file.worktreeId] = [])
    const fileIds =
      editFileIdsByWorktree[file.worktreeId] ?? (editFileIdsByWorktree[file.worktreeId] = new Set())
    const record = toPersistedOpenFile(file, editorDrafts)
    const identity = editorDocumentIdentityKey(file)
    const variants = keptVariantsByIdentity.get(identity) ?? []
    if (variants.length === 0) {
      keptVariantsByIdentity.set(identity, variants)
    }
    const kept = variants.find((variant) => !hasDivergentDraft(variant.record, record))
    if (!kept) {
      records.push(record)
      fileIds.add(file.id)
      variants.push({ record, fileId: file.id, position: records.length - 1 })
      continue
    }
    if (
      !winsOverKeptRecord(
        { record, fileId: file.id },
        kept,
        activeFileIdByWorktree[file.worktreeId]
      )
    ) {
      const withBaseline = withCarriedDiskBaseline(kept.record, record)
      if (withBaseline) {
        records[kept.position] = withBaseline
        kept.record = withBaseline
      }
      survivingFileIdByMergedId.set(file.id, kept.fileId)
      continue
    }
    records[kept.position] = record
    fileIds.delete(kept.fileId)
    fileIds.add(file.id)
    survivingFileIdByMergedId.set(kept.fileId, file.id)
    kept.record = record
    kept.fileId = file.id
  }

  for (const mergedId of survivingFileIdByMergedId.keys()) {
    survivingFileIdByMergedId.set(
      mergedId,
      resolveSurvivingFileId(survivingFileIdByMergedId, mergedId)
    )
  }
  return { openFilesByWorktree, editFileIdsByWorktree, survivingFileIdByMergedId }
}
