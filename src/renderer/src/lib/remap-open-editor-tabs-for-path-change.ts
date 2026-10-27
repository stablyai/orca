import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename } from '@/lib/path'
import { isOpenFileOnMoveOwner, type EditorMoveOwner } from '@/lib/open-editor-move-owner'
import {
  buildDiffEditorFileId,
  buildOwnedEditorFileId,
  resolveEditorFileIdForOwner,
  type OpenFilePathRekey,
  type RekeyOpenFilesResult
} from '@/store/slices/editor'
import {
  isPathInsideOrEqual,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

// Share flavor-aware containment so Windows/UNC/WSL case/separator variants retarget instead of stranding tabs on renamed paths.
export { isPathInsideOrEqual }

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return normalizeRuntimePathSeparators(path)
  }
  // Fold separators only on Windows/UNC; POSIX backslashes are filename data.
  return isWindowsAbsolutePathLike(path)
    ? normalizeRuntimePathSeparators(path).replace(/\/+$/, '')
    : path.replace(/\/+$/, '')
}

// Use absolute-path syntax to choose flavor; POSIX backslashes must remain filename data.
function foldSeparatorsForFlavor(fragment: string, flavorSource: string): string {
  return isWindowsAbsolutePathLike(flavorSource)
    ? normalizeRuntimePathSeparators(fragment)
    : fragment
}

function deriveRelativeRootFromOpenFile(filePath: string, relativePath: string): string {
  const normalizedFilePath = stripTrailingSeparators(filePath)
  const normalizedRelativePath = foldSeparatorsForFlavor(relativePath, filePath).replace(/^\/+/, '')
  if (!normalizedRelativePath || isAbsolutePathLike(relativePath)) {
    const separatorIndex = normalizedFilePath.lastIndexOf('/')
    return separatorIndex <= 0 ? '/' : normalizedFilePath.slice(0, separatorIndex)
  }
  const suffix = `/${normalizedRelativePath}`
  if (normalizedFilePath.endsWith(suffix)) {
    return stripTrailingSeparators(normalizedFilePath.slice(0, -suffix.length) || '/')
  }
  const base = basename(normalizedFilePath)
  if (base && normalizedRelativePath === base) {
    const separatorIndex = normalizedFilePath.lastIndexOf('/')
    return separatorIndex <= 0 ? '/' : normalizedFilePath.slice(0, separatorIndex)
  }
  const separatorIndex = normalizedFilePath.lastIndexOf('/')
  return separatorIndex <= 0 ? '/' : normalizedFilePath.slice(0, separatorIndex)
}

function splitAbsolutePath(path: string): { prefix: string; segments: string[] } {
  const normalized = stripTrailingSeparators(path)
  const driveMatch = /^([A-Za-z]:)(?:\/(.*))?$/.exec(normalized)
  if (driveMatch) {
    return {
      prefix: driveMatch[1].toLowerCase(),
      segments: (driveMatch[2] ?? '').split('/').filter(Boolean)
    }
  }
  if (normalized.startsWith('//')) {
    const segments = normalized.slice(2).split('/').filter(Boolean)
    const server = (segments[0] ?? '').toLowerCase()
    // Match shared normalization: wsl$ and wsl.localhost aliases identify the same distro.
    const prefix =
      server === 'wsl.localhost' || server === 'wsl$'
        ? `//wsl/${(segments[1] ?? '').toLowerCase()}`
        : `//${segments.slice(0, 2).join('/').toLowerCase()}`
    return { prefix, segments: segments.slice(2) }
  }
  if (normalized.startsWith('/')) {
    return { prefix: '/', segments: normalized.slice(1).split('/').filter(Boolean) }
  }
  return { prefix: '', segments: normalized.split('/').filter(Boolean) }
}

// Reconstruct the original-case relative suffix: equivalent UNC aliases/duplicate separators have different raw lengths, so slicing fromPath.length fabricates paths. Preserve POSIX backslashes and emit destination flavor.
function computeMovedPath(fromPath: string, toPath: string, filePath: string): string {
  const suffix = relativePathInsideRoot(fromPath, filePath)
  if (suffix === null) {
    // Selection already matched, so this is unreachable; degrade to the raw splice.
    return toPath + filePath.slice(fromPath.length)
  }
  if (suffix === '') {
    return toPath
  }
  // Choose flavor by drive/UNC syntax; POSIX/SSH backslashes are legal data, never separators to insert or strip.
  if (isWindowsAbsolutePathLike(toPath)) {
    const separator = toPath.includes('\\') ? '\\' : '/'
    return `${toPath.replace(/[\\/]+$/, '')}${separator}${suffix.split('/').join(separator)}`
  }
  return `${toPath.replace(/\/+$/, '')}/${suffix}`
}

function getRelativePathFromRoot(rootPath: string, candidatePath: string): string {
  const insideRoot = relativePathInsideRoot(rootPath, candidatePath)
  if (insideRoot !== null) {
    return insideRoot
  }

  const root = splitAbsolutePath(rootPath)
  const candidate = splitAbsolutePath(candidatePath)
  if (root.prefix !== candidate.prefix) {
    return foldSeparatorsForFlavor(candidatePath, candidatePath)
  }

  // Windows/UNC case-only segments are one directory, never a .. step; WSL Linux suffixes and POSIX remain case-sensitive.
  const foldCase =
    /^[a-z]:$/i.test(root.prefix) ||
    (root.prefix.startsWith('//') && !root.prefix.startsWith('//wsl/'))
  const sameSegment = (a: string, b: string): boolean =>
    foldCase ? a.toLowerCase() === b.toLowerCase() : a === b

  let commonSegmentCount = 0
  while (
    commonSegmentCount < root.segments.length &&
    commonSegmentCount < candidate.segments.length &&
    sameSegment(root.segments[commonSegmentCount], candidate.segments[commonSegmentCount])
  ) {
    commonSegmentCount += 1
  }

  return [
    ...Array.from({ length: root.segments.length - commonSegmentCount }, () => '..'),
    ...candidate.segments.slice(commonSegmentCount)
  ].join('/')
}

function getUpdatedRelativePath({
  filePath,
  relativePath,
  worktreeId,
  updatedPath,
  initiatingWorktreeId,
  initiatingWorktreePath
}: {
  filePath: string
  relativePath: string
  worktreeId: string
  updatedPath: string
  initiatingWorktreeId: string | undefined
  initiatingWorktreePath: string
}): string {
  // Why: a tab stored by its full path is user-named (editorTabFileAccess); keep it that way.
  if (relativePath === filePath) {
    return updatedPath
  }
  const worktreeRelative = relativePathInsideRoot(initiatingWorktreePath, filePath)
  // Compare both paths in the file’s absolute flavor so POSIX backslashes stay data.
  const normalizedRelativePath = foldSeparatorsForFlavor(relativePath, filePath).replace(/^\/+/, '')
  const usesInitiatingWorktreeRoot =
    initiatingWorktreeId !== undefined
      ? worktreeId === initiatingWorktreeId
      : worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
        worktreeRelative !== null &&
        foldSeparatorsForFlavor(worktreeRelative, filePath) === normalizedRelativePath
  const relativeRoot = usesInitiatingWorktreeRoot
    ? initiatingWorktreePath
    : deriveRelativeRootFromOpenFile(filePath, relativePath)

  return getRelativePathFromRoot(relativeRoot, updatedPath)
}

export function remapOpenEditorTabsForPathChange({
  fromPath,
  toPath,
  worktreePath,
  worktreeId,
  owner,
  moveOperationId
}: {
  fromPath: string
  toPath: string
  worktreePath: string
  worktreeId?: string
  /** The host the rename ran on; only tabs whose own owner it is are retargeted. */
  owner: EditorMoveOwner
  /** Passed by the move coordinator so dirty destinations get a content-verify
   * gate + provenance installed atomically with the re-home. */
  moveOperationId?: string
}): RekeyOpenFilesResult {
  const state = useAppStore.getState()
  // Rename affects its own host only; same-path tabs on SSH/runtime/local twins are distinct files.
  const filesToMove = state.openFiles.filter(
    (file) =>
      isPathInsideOrEqual(fromPath, file.filePath) && isOpenFileOnMoveOwner(state, file, owner)
  )
  if (filesToMove.length === 0) {
    return { ok: true }
  }

  // Atomically rekey the edit session to preserve OpenFile/id-keyed state and close the close/reopen watcher race.
  const updatedPathOf = (file: { filePath: string }): string =>
    computeMovedPath(fromPath, toPath, file.filePath)
  const relativeOf = (file: {
    filePath: string
    relativePath: string
    worktreeId: string
  }): string =>
    getUpdatedRelativePath({
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      updatedPath: updatedPathOf(file),
      initiatingWorktreeId: worktreeId,
      initiatingWorktreePath: worktreePath
    })

  // First owner gets the plain-path ID; others use owner-qualified IDs, honoring existing destinations. Same-owner collisions are rejected by rekey.
  const ownerKeyOf = (file: { worktreeId: string; runtimeEnvironmentId?: string | null }): string =>
    `${file.worktreeId}::${file.runtimeEnvironmentId?.trim() || ''}`
  const plainPathOwner = new Map<string, string>()
  const reservedSourceId = (file: {
    filePath: string
    worktreeId: string
    runtimeEnvironmentId?: string | null
  }): string => {
    const updatedPath = updatedPathOf(file)
    const ownerKey = ownerKeyOf(file)
    const claimed = plainPathOwner.get(updatedPath)
    if (claimed === ownerKey) {
      return updatedPath
    }
    if (claimed !== undefined) {
      return buildOwnedEditorFileId(updatedPath, file.worktreeId, file.runtimeEnvironmentId)
    }
    const id = resolveEditorFileIdForOwner(
      state,
      updatedPath,
      file.worktreeId,
      file.runtimeEnvironmentId,
      ['edit']
    )
    if (id === updatedPath) {
      plainPathOwner.set(updatedPath, ownerKey)
    }
    return id
  }

  const rekeys: OpenFilePathRekey[] = []
  // Edits first so a preview can point its source id at the moved edit's new id.
  const newEditIdByOldId = new Map<string, string>()
  for (const file of filesToMove) {
    if (file.mode !== 'edit') {
      continue
    }
    const newId = reservedSourceId(file)
    newEditIdByOldId.set(file.id, newId)
    rekeys.push({
      oldFileId: file.id,
      newFileId: newId,
      oldFilePath: file.filePath,
      newFilePath: updatedPathOf(file),
      newRelativePath: relativeOf(file),
      newLanguage: detectLanguage(basename(updatedPathOf(file))),
      // Only direct file renames consume untitled status; parent-directory moves preserve it.
      consumeUntitled: file.isUntitled === true && file.filePath === fromPath
    })
  }
  for (const file of filesToMove) {
    if (file.mode !== 'markdown-preview') {
      continue
    }
    const newSourceFileId =
      (file.markdownPreviewSourceFileId
        ? newEditIdByOldId.get(file.markdownPreviewSourceFileId)
        : undefined) ?? reservedSourceId(file)
    rekeys.push({
      oldFileId: file.id,
      newFileId: `markdown-preview::${newSourceFileId}`,
      oldFilePath: file.filePath,
      newFilePath: updatedPathOf(file),
      newRelativePath: relativeOf(file),
      newMarkdownPreviewSourceFileId: newSourceFileId
    })
  }
  // Only single-file staged/unstaged diffs have path-only IDs; branch/commit metadata and worktree-rooted Changes cannot be reconstructed from path.
  for (const file of filesToMove) {
    if (file.mode !== 'diff' || (file.diffSource !== 'staged' && file.diffSource !== 'unstaged')) {
      continue
    }
    const newRelativePath = relativeOf(file)
    rekeys.push({
      oldFileId: file.id,
      newFileId: buildDiffEditorFileId(
        file.worktreeId,
        file.diffSource,
        newRelativePath,
        file.runtimeEnvironmentId
      ),
      oldFilePath: file.filePath,
      newFilePath: updatedPathOf(file),
      newRelativePath
    })
  }
  if (rekeys.length === 0) {
    return { ok: true }
  }
  return useAppStore.getState().rekeyOpenFilesForPathChange({ rekeys, moveOperationId })
}
