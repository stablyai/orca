import {
  folderGroupKey,
  folderLabel,
  type AiVaultSessionProject
} from '../../../../shared/ai-vault-session-filters'
import {
  createNormalizedAiVaultScopeCwdMatcher,
  sessionFileExecutionNamespace
} from '../../../../shared/ai-vault-scope-cwd-match'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

type ProjectCandidate = {
  normalizedPath: string
  ownsNormalizedCwd: (normalizedCwd: string, filePath?: string) => boolean
}

/** Sessions that share namespace, cwd and host aliases share one attribution. */
export function aiVaultSessionProjectCwdKey(
  session: Pick<AiVaultSession, 'cwd' | 'cwdAliases' | 'filePath'>
): string {
  return JSON.stringify([
    sessionFileExecutionNamespace(session.filePath),
    session.cwd,
    ...(session.cwdAliases ?? [])
  ])
}

/**
 * Candidates owning the cwd or one of its host aliases, best first. Aliases are
 * the host's spellings of cwd under a symlinked workspace.
 */
export function matchAiVaultProjectCandidates<T extends ProjectCandidate>(
  session: Pick<AiVaultSession, 'cwdAliases' | 'filePath'>,
  cwd: string,
  candidates: readonly T[],
  compare: (left: T, right: T) => number
): T[] {
  const normalizedCwds = [cwd, ...(session.cwdAliases ?? [])].map(normalizeRuntimePathForComparison)
  const remainderByCandidate = new Map<T, number>()
  for (const candidate of candidates) {
    for (const normalizedCwd of normalizedCwds) {
      if (!candidate.ownsNormalizedCwd(normalizedCwd, session.filePath)) {
        continue
      }
      const remainder = normalizedCwd.length - candidate.normalizedPath.length
      const previous = remainderByCandidate.get(candidate)
      remainderByCandidate.set(
        candidate,
        previous === undefined ? remainder : Math.min(previous, remainder)
      )
    }
  }
  const matches = [...remainderByCandidate.keys()]
  if (!session.cwdAliases?.length) {
    return matches.sort(compare)
  }
  // Why the remainder, not the root's length: roots spelled through different links
  // have unrelated lengths; the closest root leaves the shortest tail.
  return matches.sort(
    (left, right) =>
      (remainderByCandidate.get(left) ?? 0) - (remainderByCandidate.get(right) ?? 0) ||
      compare(left, right)
  )
}

export type SessionProjectCandidate = {
  source: 'worktree' | 'setup'
  normalizedPath: string
  hostKey: ExecutionHostId
  projectId: string | null
  repoId: string | null
  // Precomputed so a 500-session pass doesn't re-normalize every root per session.
  ownsNormalizedCwd: ReturnType<typeof createNormalizedAiVaultScopeCwdMatcher>
}

export function makeProjectCandidate(
  fields: Omit<SessionProjectCandidate, 'normalizedPath' | 'ownsNormalizedCwd'> & { path: string }
): SessionProjectCandidate {
  const { path, ...rest } = fields
  const normalizedPath = normalizeRuntimePathForComparison(path)
  return {
    ...rest,
    normalizedPath,
    ownsNormalizedCwd: createNormalizedAiVaultScopeCwdMatcher([path])
  }
}

export function resolveCandidateHostId(
  ...values: readonly (string | null | undefined)[]
): ExecutionHostId {
  for (const value of values) {
    const hostId = normalizeExecutionHostId(value)
    if (hostId) {
      return hostId
    }
  }
  return LOCAL_EXECUTION_HOST_ID
}

export function hasCandidatePath(pathValue: string): boolean {
  return pathValue.trim().length > 0
}

export function folderProject(cwd: string): AiVaultSessionProject {
  return {
    kind: 'folder',
    key: folderGroupKey(cwd),
    label: folderLabel(cwd)
  }
}
