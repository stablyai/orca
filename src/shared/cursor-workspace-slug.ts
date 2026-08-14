import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/**
 * Cursor stores per-workspace state under `~/.cursor/projects/<slug>/`.
 * The slug is the absolute path with a leading slash stripped and reserved
 * path characters (`/ \ : * ? " < > |`) replaced with `-`.
 *
 * Inverse decode is lossy when a path segment itself contains `-`. Prefer
 * `.workspace-trusted` workspacePath, or match by encoding the workspace.
 */
export function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  return stripped.replace(/[\\/:*?"<>|]+/g, '-')
}

export function cursorProjectSlugFromTranscriptPath(filePath: string): string | null {
  const segments = splitPathSegments(filePath)
  const marker = segments.lastIndexOf('agent-transcripts')
  if (
    marker < 3 ||
    segments[marker - 3] !== '.cursor' ||
    segments[marker - 2] !== 'projects' ||
    !segments[marker - 1]
  ) {
    return null
  }
  return segments[marker - 1] ?? null
}

export function decodeCursorProjectSlug(slug: string): string | null {
  const trimmed = slug.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null
  }
  const windowsDrive = trimmed.match(/^([A-Za-z])-(.*)$/)
  const decoded = windowsDrive
    ? `${windowsDrive[1].toUpperCase()}:\\${windowsDrive[2].replace(/-/g, '\\')}`
    : `/${trimmed.replace(/-/g, '/')}`
  if (splitPathSegments(decoded).includes('..')) {
    return null
  }
  return decoded
}

export function isCursorTranscriptInWorkspace(
  workspacePath: string,
  transcriptPath: string
): boolean {
  const transcriptSlug = cursorProjectSlugFromTranscriptPath(transcriptPath)
  if (!transcriptSlug) {
    return false
  }
  return workspaceSlugSources(workspacePath).some((source) =>
    cursorWorkspaceSlugCandidates(source).some((candidate) =>
      slugsMatch(source, candidate, transcriptSlug)
    )
  )
}

function workspaceSlugSources(workspacePath: string): string[] {
  const wsl = parseWslUncPath(workspacePath)
  return wsl ? [workspacePath, wsl.linuxPath] : [workspacePath]
}

function cursorWorkspaceSlugCandidates(absPath: string): string[] {
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return []
  }
  const driveFolded = slug.replace(/^([A-Za-z])-/, (_, drive: string) => `${drive.toLowerCase()}-`)
  return driveFolded === slug ? [slug] : [slug, driveFolded]
}

function slugsMatch(workspacePath: string, encoded: string, transcriptSlug: string): boolean {
  if (isWindowsAbsolutePathLike(workspacePath) || /^[A-Za-z]-/.test(transcriptSlug)) {
    return encoded.toLowerCase() === transcriptSlug.toLowerCase()
  }
  return encoded === transcriptSlug
}

function splitPathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean)
}
