import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename } from '@/lib/path'
import {
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true
  }
  return candidatePath.startsWith(`${rootPath}/`) || candidatePath.startsWith(`${rootPath}\\`)
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return normalizeRuntimePathSeparators(path)
  }
  return normalizeRuntimePathSeparators(path).replace(/\/+$/, '')
}

function deriveRelativeRootFromOpenFile(filePath: string, relativePath: string): string {
  const normalizedFilePath = stripTrailingSeparators(filePath)
  const normalizedRelativePath = normalizeRuntimePathSeparators(relativePath).replace(/^\/+/, '')
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
    return {
      prefix: `//${segments.slice(0, 2).join('/').toLowerCase()}`,
      segments: segments.slice(2)
    }
  }
  if (normalized.startsWith('/')) {
    return { prefix: '/', segments: normalized.slice(1).split('/').filter(Boolean) }
  }
  return { prefix: '', segments: normalized.split('/').filter(Boolean) }
}

function getRelativePathFromRoot(rootPath: string, candidatePath: string): string {
  const insideRoot = relativePathInsideRoot(rootPath, candidatePath)
  if (insideRoot !== null) {
    return insideRoot
  }

  const root = splitAbsolutePath(rootPath)
  const candidate = splitAbsolutePath(candidatePath)
  if (root.prefix !== candidate.prefix) {
    return normalizeRuntimePathSeparators(candidatePath)
  }

  let commonSegmentCount = 0
  while (
    commonSegmentCount < root.segments.length &&
    commonSegmentCount < candidate.segments.length &&
    root.segments[commonSegmentCount] === candidate.segments[commonSegmentCount]
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
  const normalizedRelativePath = normalizeRuntimePathSeparators(relativePath).replace(/^\/+/, '')
  const usesInitiatingWorktreeRoot =
    initiatingWorktreeId !== undefined
      ? worktreeId === initiatingWorktreeId
      : worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
        worktreeRelative !== null &&
        normalizeRuntimePathSeparators(worktreeRelative) === normalizedRelativePath
  const relativeRoot = usesInitiatingWorktreeRoot
    ? initiatingWorktreePath
    : deriveRelativeRootFromOpenFile(filePath, relativePath)

  return getRelativePathFromRoot(relativeRoot, updatedPath)
}

export function remapOpenEditorTabsForPathChange({
  fromPath,
  toPath,
  worktreePath,
  worktreeId
}: {
  fromPath: string
  toPath: string
  worktreePath: string
  worktreeId?: string
}): void {
  const state = useAppStore.getState()
  const filesToMove = state.openFiles.filter((file) => isPathInsideOrEqual(fromPath, file.filePath))

  // Why: preview tabs refer to edit tab ids as their source, so edits must be
  // remapped first before reopening markdown previews with updated source ids.
  const remappedFileIds = new Map<string, string>()
  const orderedFilesToMove = [...filesToMove].sort(
    (a, b) => Number(a.mode === 'markdown-preview') - Number(b.mode === 'markdown-preview')
  )

  for (const file of orderedFilesToMove) {
    const oldFilePath = file.filePath
    const suffix = oldFilePath.slice(fromPath.length)
    const updatedPath = toPath + suffix
    const updatedRelative = getUpdatedRelativePath({
      filePath: oldFilePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      updatedPath,
      initiatingWorktreeId: worktreeId,
      initiatingWorktreePath: worktreePath
    })
    const draft = state.editorDrafts[file.id]
    const wasDirty = file.isDirty

    // Why: renameRuntimePath already moved the file. Clear the untitled marker
    // before closeFile so its cleanup path does not try to delete the old path.
    if (file.isUntitled) {
      useAppStore.getState().clearUntitled(file.id)
    }

    // Why: preview tabs use synthetic ids (`markdown-preview::...`) instead of
    // filePath, so close the real tab id before reopening at the new path.
    state.closeFile(file.id)
    if (file.mode === 'edit') {
      state.openFile(
        {
          filePath: updatedPath,
          relativePath: updatedRelative,
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          language: detectLanguage(basename(updatedPath)),
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: file.runtimeEnvironmentId === null }
      )
    } else if (file.mode === 'markdown-preview') {
      const remappedSourceFileId = file.markdownPreviewSourceFileId
        ? remappedFileIds.get(file.markdownPreviewSourceFileId)
        : undefined
      state.openMarkdownPreview(
        {
          filePath: updatedPath,
          relativePath: updatedRelative,
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          language: 'markdown'
        },
        {
          anchor: file.markdownPreviewAnchor ?? null,
          // Why: preview-only tabs may point at an owner-qualified source id
          // whose edit tab is not open. Let the store resolve that id for the
          // renamed path instead of preserving the old path in the preview id.
          sourceFileId: remappedSourceFileId
        }
      )
    } else {
      continue
    }

    const freshState = useAppStore.getState()
    const reopenedFile = freshState.openFiles.find(
      (entry) =>
        entry.filePath === updatedPath &&
        entry.worktreeId === file.worktreeId &&
        entry.mode === file.mode &&
        (entry.runtimeEnvironmentId ?? null) === (file.runtimeEnvironmentId ?? null)
    )
    const reopenedFileId = reopenedFile?.id ?? updatedPath
    remappedFileIds.set(file.id, reopenedFileId)
    if (draft !== undefined) {
      freshState.setEditorDraft(reopenedFileId, draft)
    }
    if (wasDirty) {
      freshState.markFileDirty(reopenedFileId, true)
    }
  }
}
