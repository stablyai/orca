import type { PRCheckAnnotation } from '../../../../shared/types'
import { relativePathInsideRoot, resolveRuntimePath } from '../../../../shared/cross-platform-path'

const WORKFLOW_PSEUDO_ANNOTATION_PATH = '.github'

function isRootedAnnotationPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
}

function normalizeAnnotationRelativePath(path: string): string | null {
  const trimmedPath = path.trim()
  if (!trimmedPath || trimmedPath.includes('\0') || isRootedAnnotationPath(trimmedPath)) {
    return null
  }

  const segments: string[] = []
  for (const segment of trimmedPath.replace(/[\\/]+/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  return segments.length > 0 ? segments.join('/') : null
}

export function getOpenableAnnotationLine(
  annotation: PRCheckAnnotation
): { path: string; line: number } | null {
  const path = normalizeAnnotationRelativePath(annotation.path?.trim() ?? '')
  const line = annotation.startLine
  if (!path || path === WORKFLOW_PSEUDO_ANNOTATION_PATH || !line || line < 1) {
    return null
  }
  return { path, line }
}

export function resolveAnnotationPathInsideWorktree(
  worktreePath: string,
  path: string
): { absolutePath: string; relativePath: string } | null {
  const relativePath = normalizeAnnotationRelativePath(path)
  if (!relativePath || relativePath === WORKFLOW_PSEUDO_ANNOTATION_PATH) {
    return null
  }

  const absolutePath = resolveRuntimePath(worktreePath, relativePath)
  if (relativePathInsideRoot(worktreePath, absolutePath) !== relativePath) {
    return null
  }

  return { absolutePath, relativePath }
}
