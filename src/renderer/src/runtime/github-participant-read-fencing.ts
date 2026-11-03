import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const ACCOUNT_READ_METHODS = new Set([
  'github.issue',
  'github.prForBranch',
  'github.prChecks',
  'github.prCheckDetails',
  'github.prComments',
  'github.prFileContents',
  'github.listIssues',
  'github.listWorkItems',
  'github.countWorkItems',
  'github.listAssignableUsers',
  'github.listLabels',
  'github.rateLimit',
  'github.repoSlug',
  'github.repoUpstream',
  'github.workItem',
  'github.workItemByOwnerRepo',
  'github.workItemDetails',
  'hostedReview.forBranch'
])
type PendingRead = { current: boolean; targetKey: string | null }
const pendingReads = new Map<string, Set<PendingRead>>()

function scopeKey(target: RuntimeClientTarget, repo: string): string {
  return JSON.stringify([target.kind === 'environment' ? target.environmentId : null, repo])
}

export function invalidateGitHubParticipantReads(target: RuntimeClientTarget, repo?: string): void {
  const targetKey = target.kind === 'environment' ? target.environmentId : null
  const groups = repo ? [pendingReads.get(scopeKey(target, repo)) ?? []] : pendingReads.values()
  for (const reads of groups) {
    for (const read of reads) {
      if (read.targetKey === targetKey) {
        read.current = false
      }
    }
  }
}

export function trackGitHubParticipantRead(
  target: RuntimeClientTarget,
  method: string,
  params: unknown
): {
  assertCurrent: () => void
  dispose: () => void
} {
  if (
    !ACCOUNT_READ_METHODS.has(method) ||
    !params ||
    typeof params !== 'object' ||
    !('repo' in params) ||
    typeof params.repo !== 'string'
  ) {
    return { assertCurrent: () => {}, dispose: () => {} }
  }
  const key = scopeKey(target, params.repo)
  const read: PendingRead = {
    current: true,
    targetKey: target.kind === 'environment' ? target.environmentId : null
  }
  let pending = pendingReads.get(key)
  if (!pending) {
    pending = new Set()
    pendingReads.set(key, pending)
  }
  pending.add(read)
  return {
    assertCurrent: () => {
      if (!read.current) {
        throw createRuntimeRpcAbortError()
      }
    },
    dispose: () => {
      pending.delete(read)
      if (pending.size === 0) {
        pendingReads.delete(key)
      }
    }
  }
}
