import { sessionFileExecutionNamespace } from './ai-vault-scope-cwd-match'
import type { AiVaultSession } from './ai-vault-types'
import { normalizeRuntimePathForComparison } from './cross-platform-path'

type CwdCandidate = {
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

/** Try cwd and host-reported symlink aliases, best match first. */
export function matchAiVaultSessionCwdCandidates<T extends CwdCandidate>(
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
  // Symlinked roots have unrelated lengths; the shortest remainder identifies the closest root.
  return matches.sort(
    (left, right) =>
      (remainderByCandidate.get(left) ?? 0) - (remainderByCandidate.get(right) ?? 0) ||
      compare(left, right)
  )
}
