import { getRelativePathInsideRoot } from '@/lib/path'

const TYPESCRIPT_MODEL_LANGUAGES = new Set(['typescript', 'javascript'])
const TYPESCRIPT_FILE_PATTERN = /\.(?:[cm]?[tj]sx?)$/i

export const TYPESCRIPT_WORKSPACE_MODEL_EXCLUDED_PATH_PARTS = [
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
] as const

const excludedPathParts = new Set<string>(TYPESCRIPT_WORKSPACE_MODEL_EXCLUDED_PATH_PARTS)

export function isTypeScriptWorkspaceLanguage(language: string): boolean {
  return TYPESCRIPT_MODEL_LANGUAGES.has(language)
}

export function isTypeScriptWorkspaceFilePath(filePath: string): boolean {
  if (!TYPESCRIPT_FILE_PATTERN.test(filePath)) {
    return false
  }
  return !filePath.split(/[\\/]+/).some((part) => excludedPathParts.has(part))
}

export function deriveWorkspaceRootPath(params: {
  filePath: string
  relativePath: string
  worktreePath?: string
}): string | null {
  const { filePath, relativePath, worktreePath } = params
  if (worktreePath && getRelativePathInsideRoot(filePath, worktreePath) !== null) {
    return worktreePath
  }
  if (!relativePath || relativePath === filePath) {
    return null
  }
  const candidate = filePath.slice(0, Math.max(0, filePath.length - relativePath.length))
  return candidate.replace(/[\\/]+$/, '') || null
}

// Why: null means confirmed local; a string is a remote SSH target and undefined means the
// connection hasn't resolved yet. The definition IPC only ever reads via the local filesystem, so
// undefined must not fall through to a local read of what may be a remote path (see #6648).
export function isLocalTypeScriptWorkspaceConnection(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null
}
