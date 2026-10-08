import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import type { PersistedOpenFile } from './workspace-session-state-types'

// Why shared: the desktop window and a host with no window both write editor rows into the same
// workspace session, so both must derive the same editor file ids from them.

export function runtimeOwnerKey(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

export function buildOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId) ?? 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

export function buildDiffEditorFileId(
  worktreeId: string,
  diffSource: string,
  relativePath: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const legacyId = `${worktreeId}::diff::${diffSource}::${relativePath}`
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId)
  return runtimeKey
    ? `editor-diff:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(diffSource)}:${encodeURIComponent(relativePath)}`
    : legacyId
}

export function shouldHydrateWithOwnedEditorFileId(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || runtimeOwnerKey(runtimeEnvironmentId) !== null
  )
}

export type LegacyHydratedEditorFile = {
  id: string
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  markdownPreviewSourceFileId?: string
}

export class LegacyHydratedEditorFileIndex {
  private readonly filesByPath = new Map<string, Map<string, string>>()
  private readonly ownersById = new Map<string, Set<string>>()

  private ownerKey(worktreeId: string, runtimeEnvironmentId: string | null | undefined): string {
    return JSON.stringify([worktreeId, runtimeOwnerKey(runtimeEnvironmentId)])
  }

  hasOwner(file: PersistedOpenFile, worktreeId: string): boolean {
    return (
      this.filesByPath
        .get(file.filePath)
        ?.has(this.ownerKey(worktreeId, file.runtimeEnvironmentId)) ?? false
    )
  }

  resolve(file: PersistedOpenFile, worktreeId: string): string {
    const owner = this.ownerKey(worktreeId, file.runtimeEnvironmentId)
    const existing = this.filesByPath.get(file.filePath)?.get(owner)
    if (existing !== undefined) {
      return existing
    }
    const occupied = this.ownersById.get(file.filePath)
    return occupied && (occupied.size > 1 || !occupied.has(owner))
      ? buildOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
      : file.filePath
  }

  add(file: LegacyHydratedEditorFile): void {
    const owner = this.ownerKey(file.worktreeId, file.runtimeEnvironmentId)
    let files = this.filesByPath.get(file.filePath)
    if (!files) {
      files = new Map()
      this.filesByPath.set(file.filePath, files)
    }
    if (!files.has(owner)) {
      files.set(owner, file.id)
    }
    this.addIdOwner(file.id, owner)
    if (file.markdownPreviewSourceFileId !== undefined) {
      this.addIdOwner(file.markdownPreviewSourceFileId, owner)
    }
  }

  private addIdOwner(id: string, owner: string): void {
    let owners = this.ownersById.get(id)
    if (!owners) {
      owners = new Set()
      this.ownersById.set(id, owners)
    }
    owners.add(owner)
  }
}

export type HydratedEditorFileIdAssignment = {
  worktreeId: string
  file: PersistedOpenFile
  /** The id persisted unified-tab wrappers carry for this row (their `entityId`). */
  legacyId: string
  /** The id the restored editor file gets; wrappers are migrated from `legacyId` to it. */
  id: string
}

/** Assigns restored editor file ids exactly as window hydration does, in persisted order. */
export function assignHydratedEditorFileIds(
  openFilesByWorktree: Record<string, readonly PersistedOpenFile[]>,
  isValidWorktreeId: (worktreeId: string) => boolean = () => true
): HydratedEditorFileIdAssignment[] {
  const assignments: HydratedEditorFileIdAssignment[] = []
  const usedOpenFileIds = new Set<string>()
  const legacyFileIndex = new LegacyHydratedEditorFileIndex()
  for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
    if (!isValidWorktreeId(worktreeId)) {
      continue
    }
    for (const file of files) {
      // Split tabs share one OpenFile; repeated records for the same owner are corruption.
      if (legacyFileIndex.hasOwner(file, worktreeId)) {
        continue
      }
      const legacyId = legacyFileIndex.resolve(file, worktreeId)
      // Why: floating/runtime-owned files need IDs that survive peers disappearing between restarts; collision-based IDs drift when the path is no longer open elsewhere.
      const ownedId = buildOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
      const id =
        shouldHydrateWithOwnedEditorFileId(worktreeId, file.runtimeEnvironmentId) ||
        usedOpenFileIds.has(file.filePath)
          ? ownedId
          : file.filePath
      // Why: the persisted schema allows repeated (path, worktree, runtime) tuples, and an owned id repeats verbatim — restoring both would put two files under one id.
      if (usedOpenFileIds.has(id)) {
        continue
      }
      usedOpenFileIds.add(id)
      legacyFileIndex.add({
        id: legacyId,
        filePath: file.filePath,
        worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId
      })
      assignments.push({ worktreeId, file, legacyId, id })
    }
  }
  return assignments
}
