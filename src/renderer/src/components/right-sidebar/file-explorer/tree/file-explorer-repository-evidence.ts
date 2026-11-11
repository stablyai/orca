import type { ExplorerRepositorySourceState } from './file-explorer-repository-source'
import type {
  GitFileStatus,
  GitStatusEntry
} from '../../../../../../shared/git/status/git-status-types'
import {
  getDominantStatus,
  shouldPropagateStatus
} from '../../../../lib/source-control/paths/git-path-decoration'

export type ExplorerRepositoryEvidence = {
  entries: readonly GitStatusEntry[]
  summaries: ReadonlyMap<string, GitFileStatus>
}

export function mergeExplorerRepositoryEvidence(
  previous: ExplorerRepositoryEvidence,
  latest: readonly GitStatusEntry[],
  demand: readonly string[],
  partial: boolean
): ExplorerRepositoryEvidence {
  if (!partial) {
    const entries =
      latest === previous.entries || JSON.stringify(latest) === JSON.stringify(previous.entries)
        ? previous.entries
        : latest
    return entries === previous.entries && previous.summaries.size === 0
      ? previous
      : { entries, summaries: previous.summaries.size ? new Map() : previous.summaries }
  }
  const demanded = new Set(demand)
  const seen = new Set(latest.map((entry) => `${entry.area}\0${entry.path}`))
  const entries = [
    ...latest,
    ...previous.entries.filter(
      (entry) => demanded.has(entry.path) && !seen.has(`${entry.area}\0${entry.path}`)
    )
  ]
  const summaries = new Map(
    [...previous.summaries].filter(([path]) => path === '' || demanded.has(path))
  )
  const add = (path: string, status: GitFileStatus): void => {
    const old = summaries.get(path)
    summaries.set(path, old ? getDominantStatus([old, status])! : status)
  }
  for (const entry of [...previous.entries, ...latest]) {
    if (!shouldPropagateStatus(entry.status)) {
      continue
    }
    add('', entry.status)
    let path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
    if (!entry.path.endsWith('/') && !entry.submodule) {
      path = path.slice(0, Math.max(0, path.lastIndexOf('/')))
    }
    while (path) {
      if (demanded.has(path)) {
        add(path, entry.status)
      }
      const slash = path.lastIndexOf('/')
      path = slash === -1 ? '' : path.slice(0, slash)
    }
  }
  return {
    entries:
      entries === previous.entries || JSON.stringify(entries) === JSON.stringify(previous.entries)
        ? previous.entries
        : entries,
    summaries:
      summaries.size === previous.summaries.size &&
      [...summaries].every(([path, status]) => previous.summaries.get(path) === status)
        ? previous.summaries
        : summaries
  }
}

export function forgetExplorerRepositoryPaths(
  source: ExplorerRepositorySourceState,
  absent: (path: string) => boolean
): boolean {
  const fullPath = (path: string): string => (source.path ? `${source.path}/${path}` : path)
  const entries = source.entries.filter((entry) => !absent(fullPath(entry.path)))
  const summaries = new Map([...source.summaries].filter(([path]) => !absent(fullPath(path))))
  source.latestEntries = source.latestEntries.filter((entry) => !absent(fullPath(entry.path)))
  if (entries.length === source.entries.length && summaries.size === source.summaries.size) {
    return false
  }
  source.entries = entries
  source.summaries = summaries
  return true
}
