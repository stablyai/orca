import { getConnectionIdForFile } from '@/lib/connection-context'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { dirname } from '@/lib/path'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/worktree/types'
import type { MarkdownPreviewSourceOpenFile } from './markdown-preview-types'

export function findMarkdownPreviewSourceOpenFile(
  openFiles: MarkdownPreviewSourceOpenFile[],
  params: {
    sourceFileId: string | null
    filePath: string
    sourceWorktreeId: string | null
    sourceRuntimeEnvironmentId: string | null | undefined
  }
): MarkdownPreviewSourceOpenFile | undefined {
  const ownerMatches = (file: MarkdownPreviewSourceOpenFile): boolean =>
    (!params.sourceWorktreeId || file.worktreeId === params.sourceWorktreeId) &&
    (params.sourceRuntimeEnvironmentId === undefined ||
      (file.runtimeEnvironmentId ?? null) === (params.sourceRuntimeEnvironmentId ?? null))

  if (params.sourceFileId) {
    const idMatch = openFiles.find((file) => file.id === params.sourceFileId && ownerMatches(file))
    return (
      idMatch ??
      openFiles.find(
        (file) =>
          file.mode === 'markdown-preview' &&
          file.filePath === params.filePath &&
          file.markdownPreviewSourceFileId === params.sourceFileId &&
          ownerMatches(file)
      ) ??
      openFiles.find((file) => file.id === params.sourceFileId)
    )
  }

  return openFiles.find((file) => file.filePath === params.filePath && ownerMatches(file))
}

export function findMarkdownPreviewOpenedEditFileId(
  openFiles: MarkdownPreviewSourceOpenFile[],
  activeFileIdByWorktree: Record<string, string | null>,
  params: { filePath: string; worktreeId: string }
): string {
  const activeFileId = activeFileIdByWorktree[params.worktreeId]
  const activeFile = openFiles.find(
    (file) =>
      file.id === activeFileId &&
      file.filePath === params.filePath &&
      file.worktreeId === params.worktreeId &&
      file.mode === 'edit'
  )
  if (activeFile) {
    return activeFile.id
  }
  return (
    openFiles.find(
      (file) =>
        file.filePath === params.filePath &&
        file.worktreeId === params.worktreeId &&
        file.mode === 'edit'
    )?.id ?? params.filePath
  )
}

function normalizeMarkdownPreviewAbsolutePath(absolutePath: string): string {
  return absolutePath.replaceAll('\\', '/')
}

function normalizeMarkdownPreviewRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
}

function isMarkdownPreviewAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function formatMarkdownPreviewRootPath(rootPath: string): string {
  if (rootPath === '') {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(rootPath)) {
    return `${rootPath}/`
  }
  return rootPath
}

export function deriveMarkdownPreviewSourceRoot(
  filePath: string,
  relativePath: string | null | undefined
): string {
  const normalizedFilePath = normalizeMarkdownPreviewAbsolutePath(filePath)
  const normalizedRelativePath =
    relativePath && !isMarkdownPreviewAbsolutePathLike(relativePath)
      ? normalizeMarkdownPreviewRelativePath(relativePath)
      : ''

  if (normalizedRelativePath) {
    const suffix = `/${normalizedRelativePath}`
    if (normalizedFilePath.endsWith(suffix)) {
      return formatMarkdownPreviewRootPath(normalizedFilePath.slice(0, -suffix.length))
    }
  }

  return formatMarkdownPreviewRootPath(normalizeMarkdownPreviewAbsolutePath(dirname(filePath)))
}

function findWorktreeForMarkdownPreviewPath(
  worktreesByRepo: Record<string, Worktree[]>,
  absolutePath: string,
  acceptsWorktree: (worktree: Worktree) => boolean = () => true
): Worktree | null {
  let bestMatch: Worktree | null = null
  let bestMatchLength = -1

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (
        acceptsWorktree(worktree) &&
        relativePathInsideRoot(worktree.path, absolutePath) !== null
      ) {
        const normalizedWorktreePathLength = normalizeMarkdownPreviewAbsolutePath(
          worktree.path
        ).length
        if (normalizedWorktreePathLength > bestMatchLength) {
          bestMatch = worktree
          bestMatchLength = normalizedWorktreePathLength
        }
      }
    }
  }

  return bestMatch
}

export function findMarkdownPreviewTargetWorktree(
  worktreesByRepo: Record<string, Worktree[]>,
  absolutePath: string,
  sourceWorktree: Worktree | null,
  sourceOwner: HttpLinkSourceOwner
): Worktree | null {
  if (sourceWorktree && relativePathInsideRoot(sourceWorktree.path, absolutePath) !== null) {
    return sourceWorktree
  }
  return findWorktreeForMarkdownPreviewPath(worktreesByRepo, absolutePath, (worktree) => {
    const connectionId = getConnectionIdForFile(worktree.id, absolutePath)
    if (sourceOwner.kind === 'local') {
      return connectionId === null
    }
    if (sourceOwner.kind === 'ssh') {
      return connectionId === sourceOwner.connectionId
    }
    return false
  })
}

export function resolveMarkdownPreviewSourceWorktree(
  worktreesByRepo: Record<string, Worktree[]>,
  sourceWorktreeId: string | null | undefined,
  filePath: string
): Worktree | null {
  const sourceWorktree = sourceWorktreeId
    ? (findWorktreeById(worktreesByRepo, sourceWorktreeId) ?? null)
    : null

  return sourceWorktree ?? findWorktreeForMarkdownPreviewPath(worktreesByRepo, filePath)
}

export function getMarkdownPreviewSourceRelativePath(
  filePath: string,
  sourceWorktreePath: string
): string | null {
  return relativePathInsideRoot(sourceWorktreePath, filePath)
}
