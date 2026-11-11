import { useMemo } from 'react'
import type {
  GitFileStatus,
  GitStatusEntry
} from '../../../../../../shared/git/status/git-status-types'
import {
  buildFolderStatusMap,
  buildStatusMap,
  getDominantStatus,
  shouldPropagateStatus
} from '../../../../lib/source-control/paths/git-path-decoration'
import {
  explorerRepositoryOwner,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'

export type ExplorerStatusLookup<T> = Pick<ReadonlyMap<string, T>, 'get' | 'has'>
type Projection = {
  entries: readonly GitStatusEntry[]
  summaries: ReadonlyMap<string, GitFileStatus>
  files: ReadonlyMap<string, GitFileStatus>
  folders: ReadonlyMap<string, GitFileStatus | null>
  aggregate: GitFileStatus | null
}
type Counters = ReadonlyMap<string, ReadonlyMap<GitFileStatus, number>>
const NO_SUMMARIES: ReadonlyMap<string, GitFileStatus> = new Map()

function projectSource(
  path: string | undefined,
  entries: readonly GitStatusEntry[],
  summaries: ReadonlyMap<string, GitFileStatus>,
  roots: ReadonlySet<string>
): Projection {
  const owned =
    roots.size === 0
      ? entries
      : entries.filter((entry) => {
          const full = path ? `${path}/${entry.path}` : entry.path
          return explorerRepositoryOwner(roots, full.replace(/\/$/, '')) === path
        })
  const files = buildStatusMap(owned)
  const folders = buildFolderStatusMap(owned)
  for (const entry of owned) {
    const relative = entry.path.replace(/\/$/, '')
    const full = path ? `${path}/${relative}` : relative
    if (
      shouldPropagateStatus(entry.status) &&
      (entry.path.endsWith('/') || entry.submodule || roots.has(full))
    ) {
      folders.set(
        relative,
        getDominantStatus([folders.get(relative), entry.status].filter((status) => status != null))
      )
    }
  }
  for (const [relative, status] of summaries) {
    if (
      relative &&
      explorerRepositoryOwner(roots, path ? `${path}/${relative}/` : `${relative}/`) === path
    ) {
      folders.set(
        relative,
        getDominantStatus([folders.get(relative), status].filter((item) => item != null))
      )
    }
  }
  const aggregate = getDominantStatus([
    ...owned.filter((entry) => shouldPropagateStatus(entry.status)).map((entry) => entry.status),
    ...(summaries.has('') ? [summaries.get('')!] : [])
  ])
  return { entries, summaries, files, folders, aggregate }
}

function changeContribution(
  counters: Map<string, ReadonlyMap<GitFileStatus, number>>,
  path: string | undefined,
  status: GitFileStatus | null | undefined,
  delta: number
): void {
  if (!path || !status) {
    return
  }
  let ancestor = path
  while (ancestor) {
    const counts = new Map(counters.get(ancestor))
    const count = (counts.get(status) ?? 0) + delta
    if (count) {
      counts.set(status, count)
    } else {
      counts.delete(status)
    }
    if (counts.size) {
      counters.set(ancestor, counts)
    } else {
      counters.delete(ancestor)
    }
    const slash = ancestor.lastIndexOf('/')
    ancestor = slash === -1 ? '' : ancestor.slice(0, slash)
  }
}

function createLookups(
  projections: ReadonlyMap<string | undefined, Projection>,
  roots: ReadonlySet<string>,
  counters: Counters
) {
  if (roots.size === 0) {
    const root = projections.get(undefined)
    return {
      statusByRelativePath: root?.files ?? new Map<string, GitFileStatus>(),
      folderStatusByRelativePath: root?.folders ?? new Map<string, GitFileStatus | null>()
    }
  }
  const lookup = (path: string, folder: boolean): GitFileStatus | null | undefined => {
    const owner = explorerRepositoryOwner(roots, path)
    const own = projections.get(owner)
    const relative = owner ? path.slice(owner.length + 1) : path
    const status = folder ? own?.folders.get(relative) : own?.files.get(relative)
    if (!folder) {
      return status
    }
    const contributions = counters.get(path)
    return contributions
      ? getDominantStatus([...(status ? [status] : []), ...contributions.keys()])
      : status
  }
  return {
    statusByRelativePath: {
      get: (path: string) => lookup(path, false) ?? undefined,
      has: (path: string) => lookup(path, false) != null
    } satisfies ExplorerStatusLookup<GitFileStatus>,
    folderStatusByRelativePath: {
      get: (path: string) => lookup(path, true),
      has: (path: string) => lookup(path, true) != null
    } satisfies ExplorerStatusLookup<GitFileStatus | null>
  }
}

/** Per-repository maps survive sibling status and ignore updates; views never copy entry payloads. */
export class ExplorerRepositoryDecorations {
  private projections = new Map<string | undefined, Projection>()
  private roots: ReadonlySet<string> = new Set()
  private counters: Counters = new Map()
  private lookups = createLookups(this.projections, this.roots, this.counters)

  update(rootEntries: readonly GitStatusEntry[], sources: readonly ExplorerRepositorySource[]) {
    const nextRoots = new Set(sources.map((source) => source.path))
    const topology = [...nextRoots, ...this.roots].filter(
      (path) => nextRoots.has(path) !== this.roots.has(path)
    )
    const next = new Map(this.projections)
    const counters = new Map(this.counters)
    let changed = topology.length > 0
    const inputs = [{ path: undefined, entries: rootEntries, summaries: NO_SUMMARIES }, ...sources]
    for (const source of inputs) {
      const old = next.get(source.path)
      const maskChanged = topology.some(
        (path) =>
          source.path === undefined || source.path === '' || path.startsWith(`${source.path}/`)
      )
      if (old?.entries === source.entries && old.summaries === source.summaries && !maskChanged) {
        continue
      }
      const projection = projectSource(source.path, source.entries, source.summaries, nextRoots)
      changeContribution(counters, source.path, old?.aggregate, -1)
      changeContribution(counters, source.path, projection.aggregate, 1)
      next.set(source.path, projection)
      changed = true
    }
    for (const [path, projection] of next) {
      if (path !== undefined && !nextRoots.has(path)) {
        changeContribution(counters, path, projection.aggregate, -1)
        next.delete(path)
        changed = true
      }
    }
    if (changed) {
      this.projections = next
      this.roots = nextRoots
      this.counters = counters
      this.lookups = createLookups(next, nextRoots, counters)
    }
    return this.lookups
  }
}

export function buildExplorerRepositoryDecorations(
  rootEntries: readonly GitStatusEntry[],
  sources: readonly ExplorerRepositorySource[]
) {
  return new ExplorerRepositoryDecorations().update(rootEntries, sources)
}

export function useExplorerRepositoryDecorations(
  entries: readonly GitStatusEntry[],
  sources: readonly ExplorerRepositorySource[]
) {
  const decorations = useMemo(() => new ExplorerRepositoryDecorations(), [])
  return decorations.update(entries, sources)
}
