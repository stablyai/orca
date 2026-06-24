import { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'
import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'
import type { Repo } from './types'
import {
  WORKTREE_KEY_SCHEME,
  formatWorktreeKey,
  parseStrictWorktreeKey
} from './worktree-key-format'

export { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
  hostId?: ExecutionHostId
}

export type ParsedCanonicalWorktreeKey = {
  hostId: ExecutionHostId
  repoId: string
  worktreePath: string
}

export type ParsedAnyWorktreeId =
  | ({ format: 'canonical' } & ParsedCanonicalWorktreeKey)
  | ({ format: 'legacy' } & ParsedWorktreeId)

export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'
const FOLDER_WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)

export function makeLegacyWorktreeId(repoId: string, path: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${path}`
}

export function makeWorktreeKey(input: {
  hostId: ExecutionHostId
  repoId: string
  path: string
}): string {
  return formatWorktreeKey(input)
}

export function makeRepoWorktreeKey(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  path: string
): string {
  return makeWorktreeKey({
    hostId: getRepoExecutionHostId(repo),
    repoId: repo.id,
    path
  })
}

export function getRepoWorktreeIdAliases(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  path: string
): Set<string> {
  return new Set([makeRepoWorktreeKey(repo, path), makeLegacyWorktreeId(repo.id, path)])
}

export function isRepoWorktreeIdAlias(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  path: string,
  worktreeId: string
): boolean {
  return getRepoWorktreeIdAliases(repo, path).has(worktreeId)
}

export function parseWorktreeKey(worktreeId: string): ParsedCanonicalWorktreeKey | null {
  return parseStrictWorktreeKey(worktreeId)
}

export function parseAnyWorktreeId(worktreeId: string): ParsedAnyWorktreeId | null {
  const canonical = parseWorktreeKey(worktreeId)
  if (canonical) {
    return { format: 'canonical', ...canonical }
  }
  if (worktreeId.startsWith(WORKTREE_KEY_SCHEME)) {
    return null
  }
  const legacy = splitLegacyWorktreeId(worktreeId)
  return legacy ? { format: 'legacy', ...legacy } : null
}

export function isLegacyWorktreeId(worktreeId: string): boolean {
  return (
    !worktreeId.startsWith(WORKTREE_KEY_SCHEME) &&
    !parseWorktreeKey(worktreeId) &&
    splitLegacyWorktreeId(worktreeId) !== null
  )
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const canonical = parseWorktreeKey(worktreeId)
  if (canonical) {
    return canonical.repoId
  }
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

function splitLegacyWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIdx),
    worktreePath: worktreeId.slice(separatorIdx + WORKTREE_ID_SEPARATOR.length)
  }
}

export function splitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const canonical = parseWorktreeKey(worktreeId)
  if (canonical) {
    return canonical
  }
  if (worktreeId.startsWith(WORKTREE_KEY_SCHEME)) {
    return null
  }
  return splitLegacyWorktreeId(worktreeId)
}

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return null
  }
  return {
    ...(parsed.hostId !== undefined ? { hostId: parsed.hostId } : {}),
    repoId: parsed.repoId,
    // Why: folder projects can have multiple workspace sessions backed by the
    // same directory. Their IDs carry a UUID suffix, but filesystem callers
    // still need the real folder path as cwd/root.
    worktreePath: parsed.worktreePath.replace(FOLDER_WORKSPACE_INSTANCE_SUFFIX, '')
  }
}

export function getWorktreePathBasenameFromId(worktreeId: string): string | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const normalizedPath = parsed?.worktreePath.trim().replace(/[\\/]+$/g, '') ?? ''
  if (!normalizedPath) {
    return null
  }
  const basename = normalizedPath.split(/[\\/]/).filter(Boolean).at(-1)?.trim()
  return basename || null
}
