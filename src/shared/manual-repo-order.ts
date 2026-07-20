import { getRepoExecutionHostId, normalizeExecutionHostId } from './execution-host'
import type { ManualRepoOrderEntry, Repo } from './types'

function getEntryKey(entry: ManualRepoOrderEntry): string {
  return `${entry.hostId}\0${entry.repoId}`
}

export function normalizeManualRepoOrder(value: unknown): ManualRepoOrderEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  const entries: ManualRepoOrderEntry[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as { hostId?: unknown; repoId?: unknown }
    const hostId = typeof raw.hostId === 'string' ? normalizeExecutionHostId(raw.hostId) : null
    const repoId = typeof raw.repoId === 'string' ? raw.repoId : ''
    if (!hostId || !repoId.trim()) {
      continue
    }
    const entry = { hostId, repoId }
    const key = getEntryKey(entry)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

export function getManualRepoOrder(repos: readonly Repo[]): ManualRepoOrderEntry[] {
  return normalizeManualRepoOrder(
    repos.map((repo) => ({ hostId: getRepoExecutionHostId(repo), repoId: repo.id }))
  )
}

export function applyManualRepoOrder(
  repos: readonly Repo[],
  order: readonly ManualRepoOrderEntry[] | null | undefined
): Repo[] {
  const normalized = normalizeManualRepoOrder(order)
  if (normalized.length === 0) {
    return [...repos]
  }
  const rankByKey = new Map(normalized.map((entry, index) => [getEntryKey(entry), index]))
  return repos
    .map((repo, index) => ({
      repo,
      index,
      rank: rankByKey.get(getEntryKey({ hostId: getRepoExecutionHostId(repo), repoId: repo.id }))
    }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) {
        return a.index - b.index
      }
      if (a.rank === undefined) {
        return 1
      }
      if (b.rank === undefined) {
        return -1
      }
      return a.rank - b.rank || a.index - b.index
    })
    .map(({ repo }) => repo)
}
