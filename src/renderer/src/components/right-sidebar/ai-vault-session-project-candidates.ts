import { isAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'
import {
  folderGroupKey,
  folderLabel,
  type AiVaultSessionProject
} from '../../../../shared/ai-vault-session-filters'
import { createNormalizedAiVaultScopeCwdMatcher } from '../../../../shared/ai-vault-scope-cwd-match'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export {
  aiVaultSessionProjectCwdKey,
  matchAiVaultSessionCwdCandidates as matchAiVaultProjectCandidates
} from '../../../../shared/ai-vault-session-cwd-candidates'

export type SessionProjectCandidate = {
  workspaceId?: string
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

export function canonicalAiVaultSessionProject(
  session: AiVaultSession,
  labels: ReadonlyMap<string, string>
): AiVaultSessionProject | null {
  const key = session.projectOwnerKey
  if (key === null) {
    return session.cwd ? folderProject(session.cwd) : { kind: 'unknown', key: 'unknown', label: '' }
  }
  return isAiVaultProjectKey(key) ? { kind: 'repo', key, label: labels.get(key) ?? key } : null
}

export function compareAiVaultProjectCandidates(
  left: SessionProjectCandidate,
  right: SessionProjectCandidate
): number {
  const lengthDifference = right.normalizedPath.length - left.normalizedPath.length
  if (lengthDifference !== 0) {
    return lengthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'worktree' ? -1 : 1
}
