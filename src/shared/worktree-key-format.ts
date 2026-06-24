import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'

export type ParsedWorktreeKeyParts = {
  hostId: ExecutionHostId
  repoId: string
  worktreePath: string
}

export const WORKTREE_KEY_SCHEME = 'orca-worktree://'
export const WORKTREE_KEY_PREFIX = `${WORKTREE_KEY_SCHEME}v1?`

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value)
}

function decodeStrictKeyPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 ? decoded : null
  } catch {
    return null
  }
}

export function formatWorktreeKey(input: {
  hostId: ExecutionHostId
  repoId: string
  path: string
}): string {
  return `${WORKTREE_KEY_PREFIX}${[
    `hostId=${encodeKeyPart(input.hostId)}`,
    `repoId=${encodeKeyPart(input.repoId)}`,
    `path=${encodeKeyPart(input.path)}`
  ].join('&')}`
}

export function parseStrictWorktreeKey(worktreeId: string): ParsedWorktreeKeyParts | null {
  if (!worktreeId.startsWith(WORKTREE_KEY_PREFIX)) {
    return null
  }
  const query = worktreeId.slice(WORKTREE_KEY_PREFIX.length)
  const parts = query.split('&')
  if (parts.length !== 3) {
    return null
  }
  const expectedKeys = ['hostId', 'repoId', 'path'] as const
  const values: Partial<Record<(typeof expectedKeys)[number], string>> = {}
  for (const [index, part] of parts.entries()) {
    const separatorIndex = part.indexOf('=')
    if (separatorIndex <= 0) {
      return null
    }
    const key = part.slice(0, separatorIndex)
    if (key !== expectedKeys[index]) {
      return null
    }
    const decoded = decodeStrictKeyPart(part.slice(separatorIndex + 1))
    if (decoded === null) {
      return null
    }
    values[key] = decoded
  }
  const rawHostId = values.hostId
  const rawRepoId = values.repoId
  const rawPath = values.path
  if (!rawHostId || !rawRepoId || !rawPath) {
    return null
  }
  const hostId = normalizeExecutionHostId(rawHostId)
  if (!hostId) {
    return null
  }
  if (formatWorktreeKey({ hostId, repoId: rawRepoId, path: rawPath }) !== worktreeId) {
    return null
  }
  return { hostId, repoId: rawRepoId, worktreePath: rawPath }
}
