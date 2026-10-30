import type { GitHistoryItem, GitHistoryResult } from './git-history-types'

type GitHistoryPushStateInput = Pick<
  GitHistoryResult,
  'items' | 'currentRef' | 'remoteRef' | 'mergeBase'
>

// The loaded commits `startId` reaches through parent links, itself included.
export function collectGitHistoryAncestorIds(
  items: readonly Pick<GitHistoryItem, 'id' | 'parentIds'>[],
  startId: string
): Set<string> {
  const parentsById = new Map<string, readonly string[]>()
  for (const item of items) {
    if (!parentsById.has(item.id)) {
      parentsById.set(item.id, item.parentIds)
    }
  }
  const reached = new Set<string>()
  const pending = [startId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (reached.has(id) || !parentsById.has(id)) {
      continue
    }
    reached.add(id)
    pending.push(...parentsById.get(id)!)
  }
  return reached
}

// git.status's verdict on the branch's upstream, which also counts an unconfigured same-name origin branch.
export type GitHistoryUpstreamVerdict = { hasUpstream: boolean; ahead: number }

// History is HEAD-only, so a loaded commit is on the upstream exactly when the upstream merge base reaches it.
// Null when push state is unknown (detached HEAD, or an upstream history did not name), so callers claim nothing.
export function resolveGitHistoryUnpushedIds(
  result: GitHistoryPushStateInput,
  upstream?: GitHistoryUpstreamVerdict
): Set<string> | null {
  const { items, currentRef, remoteRef, mergeBase } = result
  if (!currentRef || currentRef.category === 'commits') {
    return null
  }
  if (!remoteRef) {
    // History reads only configured tracking; a branch pushed without -u still has an effective upstream.
    if (upstream?.hasUpstream === false) {
      return new Set(items.map((item) => item.id))
    }
    return upstream?.hasUpstream && upstream.ahead === 0 ? new Set() : null
  }
  if (remoteRef.revision && remoteRef.revision === currentRef.revision) {
    return new Set()
  }
  const pushed = mergeBase ? collectGitHistoryAncestorIds(items, mergeBase) : new Set()
  return new Set(items.filter((item) => !pushed.has(item.id)).map((item) => item.id))
}
