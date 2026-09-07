import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename } from '@/lib/path'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
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

// Re-export the shared, flavor-aware containment check: move selection must fold
// case + separators (Windows/UNC/WSL) so a same-file tab differing only in case
// isn't missed and left stranded on the vanished source path after the rename.
export { isPathInsideOrEqual }

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return normalizeRuntimePathSeparators(path)
  }
  // Only fold backslashes to `/` for Windows/UNC paths; on POSIX a backslash is
  // legal filename data and must not be treated as a separator.
  return isWindowsAbsolutePathLike(path)
    ? normalizeRuntimePathSeparators(path).replace(/\/+$/, '')
    : path.replace(/\/+$/, '')
}

// Fold `\`→`/` only when the associated absolute path (flavorSource) is Windows
// drive/UNC syntax; on POSIX a backslash is legal filename data, not a separator.
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
    // Canonicalize the two WSL UNC aliases to one identity (matches the shared
    // normalizer) so `\\wsl$\Distro` and `\\wsl.localhost\Distro` compare equal.
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

// Rebuild via suffix, not `slice(fromPath.length)`: containment matches paths of
// differing raw length (wsl$ vs wsl.localhost, duplicate separators), so a raw
// splice would fabricate a path. relativePathInsideRoot gives the original-case
// `/`-separated suffix (POSIX backslashes preserved) to re-emit in dest flavor.
function computeMovedPath(fromPath: string, toPath: string, filePath: string): string {
  const suffix = relativePathInsideRoot(fromPath, filePath)
  if (suffix === null) {
    // Selection already matched, so this is unreachable; degrade to the raw splice.
    return toPath + filePath.slice(fromPath.length)
  }
  if (suffix === '') {
    return toPath
  }
  // Flavor by SYNTAX (drive/UNC), never by "contains a backslash": a POSIX/SSH
  // path may hold a legal backslash, so it must keep `/`, never gain one, and
  // never have a trailing backslash stripped as if it were a separator.
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

  // Windows drive/UNC segments are case-insensitive, so a case-only difference
  // is the SAME directory and must not emit a spurious `..`. The WSL Linux suffix
  // (canonical prefix //wsl/<distro>) stays case-sensitive, as do POSIX roots.
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
  const worktreeRelative = relativePathInsideRoot(initiatingWorktreePath, filePath)
  // Both sides fold on the same flavor (the file's own absolute path) so the
  // comparison stays consistent and a legal POSIX backslash isn't mistaken for a
  // separator.
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
  moveOperationId
}: {
  fromPath: string
  toPath: string
  worktreePath: string
  worktreeId?: string
  /** Passed by the move coordinator so dirty destinations get a content-verify
   * gate + provenance installed atomically with the re-home. */
  moveOperationId?: string
}): RekeyOpenFilesResult {
  const state = useAppStore.getState()
  // The rename only touched the initiating execution host. The same absolute
  // path can be open on a DIFFERENT host (a second SSH connection, or local vs
  // runtime) as a distinct physical file — never retarget those tabs.
  const initiatingHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const filesToMove = state.openFiles.filter(
    (file) =>
      isPathInsideOrEqual(fromPath, file.filePath) &&
      getExecutionHostIdForWorktree(state, file.worktreeId) === initiatingHostId
  )
  if (filesToMove.length === 0) {
    return { ok: true }
  }

  // Retarget the live edit session in place (atomic store rekey) instead of
  // close+reopen: preserves the full OpenFile + all id-keyed state and closes
  // the watcher-race window that close/reopen opened.
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

  // First owner to claim a destination gets the plain-path id; other owners of
  // the same path get an owner-qualified id (as sequential openFile did). An
  // unaffected tab already at the destination is honoured via
  // resolveEditorFileIdForOwner; a same-owner conflict is a real collision the
  // rekey action rejects.
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
      // Only an explicit rename of the file itself consumes untitled status; a
      // containing-directory move keeps it.
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
  // Only single-file staged/unstaged diff ids are purely path-derived, so only
  // they can be retargeted from path. Branch/commit diffs carry extra compare
  // metadata and "Changes" is worktree-rooted — rebuilding those from path alone
  // would produce the wrong id.
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
