import type { ExecutionHostId } from './execution-host'

/** Why `unverifiable`: loss of contact with the owning host is never evidence the folder is gone. */
export type RepoPathStatus =
  | { state: 'present' }
  | { state: 'missing'; reason: 'not-found' | 'not-directory' | 'not-git-root' }
  | { state: 'moved'; target: string }
  | { state: 'unverifiable' }

export type RepoPathStatusEntry = {
  repoId: string
  hostId: ExecutionHostId
  path: string
  status: RepoPathStatus
}

export const REPO_PATH_STATUS_TTL_MS = 15_000

export const REPO_RELINK_ERROR_CODES = [
  'repo_relink_path_not_found',
  'repo_relink_path_not_directory',
  'repo_relink_path_not_absolute',
  'repo_relink_not_git_toplevel',
  'repo_relink_path_registered',
  'repo_relink_different_repository',
  'repo_relink_identity_unverified',
  'repo_relink_host_unverifiable',
  'repo_relink_folder_repo_unsupported'
] as const

export type RepoRelinkErrorCode = (typeof REPO_RELINK_ERROR_CODES)[number]

/** Only these refusals can be overridden: the folder is a valid checkout, Orca just cannot prove it is the same one. */
export function isForceableRepoRelinkError(code: RepoRelinkErrorCode): boolean {
  return code === 'repo_relink_different_repository' || code === 'repo_relink_identity_unverified'
}

const RELINK_ERROR_PATTERN = new RegExp(`^(${REPO_RELINK_ERROR_CODES.join('|')}):\\s?(.*)$`, 's')

export function formatRepoRelinkError(code: RepoRelinkErrorCode, detail: string): string {
  return `${code}: ${detail}`
}

/** Parses an error message that crossed IPC or RPC; transports prefix it, so match anywhere. */
export function parseRepoRelinkError(
  message: string
): { code: RepoRelinkErrorCode; detail: string } | null {
  const start = REPO_RELINK_ERROR_CODES.map((code) => message.indexOf(code))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  if (start === undefined) {
    return null
  }
  const match = RELINK_ERROR_PATTERN.exec(message.slice(start))
  if (!match) {
    return null
  }
  const code = REPO_RELINK_ERROR_CODES.find((candidate) => candidate === match[1])
  return code ? { code, detail: match[2] ?? '' } : null
}
