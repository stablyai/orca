import { ExplorerRepositoryIgnoredQueries } from './file-explorer-repository-ignored'
import { createExplorerRepositoryValidation } from './file-explorer-repository-validation'
import {
  partitionExplorerRepositoryDemand,
  type ExplorerRepositoryDemand
} from './file-explorer-repository-paths'
import {
  mergeExplorerRepositoryEvidence,
  type ExplorerRepositoryEvidence
} from './file-explorer-repository-evidence'
import type {
  GitRepositoryStatusRequest,
  GitRepositoryStatus
} from '../../../../../../shared/git/status/git-repository-status'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import {
  createGitStatusRefreshScheduler,
  type GitStatusRefreshScheduler
} from '../../source-control/sync/git-status-refresh-scheduler'

export type ExplorerRepositorySource = ExplorerRepositoryEvidence & {
  path: string
  entries: readonly GitStatusEntry[]
  ignored: ReadonlyMap<string, boolean>
}
export type ExplorerRepositoryRead = (
  request: GitRepositoryStatusRequest,
  signal: AbortSignal
) => Promise<GitRepositoryStatus[] | undefined>
export type ExplorerRepositorySourceState = ExplorerRepositorySource & {
  scheduler: GitStatusRefreshScheduler
  proofRevision: number
  proofRetryAt: number
  statusDirty: boolean
  query: string[]
  ignoredQueries: ExplorerRepositoryIgnoredQueries
  latestEntries: readonly GitStatusEntry[]
  partial: boolean
}

export const EXPLORER_REPOSITORY_SCHEDULER_OPTIONS = {
  safetyIntervalMs: 60_000,
  preserveSafetyDeadline: true,
  activityDebounceMs: 125,
  activityMinGapMs: 3000,
  slowTaskBackoff: { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
}
const EMPTY_ENTRIES: readonly GitStatusEntry[] = []

type SourceOwner = {
  read: ExplorerRepositoryRead
  generation: () => number
  current: (
    source: ExplorerRepositorySourceState,
    generation?: number,
    signal?: AbortSignal
  ) => boolean
  admit: (
    key: ExplorerRepositorySourceState,
    signal: AbortSignal,
    run: () => Promise<void>
  ) => Promise<void>
  remove: () => void
  publish: () => void
}
export function createExplorerRepositorySource(
  path: string,
  owner: SourceOwner
): ExplorerRepositorySourceState {
  const statusValidation = createExplorerRepositoryValidation()
  const source: ExplorerRepositorySourceState = {
    path,
    entries: EMPTY_ENTRIES,
    summaries: new Map(),
    latestEntries: EMPTY_ENTRIES,
    partial: false,
    ignored: new Map(),
    proofRevision: 0,
    proofRetryAt: -Infinity,
    statusDirty: true,
    query: [],
    ignoredQueries: new ExplorerRepositoryIgnoredQueries(path, {
      read: owner.read,
      current: () => owner.current(source),
      admit: (signal, run) => owner.admit(source, signal, run),
      remove: owner.remove,
      publish: (answers) => {
        source.ignored = answers
        owner.publish()
      }
    }),
    scheduler: createGitStatusRefreshScheduler(
      async ({ signal }) => {
        if (!owner.current(source)) {
          return
        }
        source.statusDirty ||= Date.now() >= statusValidation.dueAt()
        const generation = owner.generation()
        if (source.statusDirty && Date.now() >= source.proofRetryAt) {
          source.statusDirty = false
          let validated = false
          let proofRevision: number | undefined
          try {
            await owner.admit(source, signal, async () => {
              proofRevision = source.proofRevision
              const results = await owner.read(
                { repositoryPaths: [path], repositoryIntent: 'status' },
                signal
              )
              if (
                !owner.current(source, generation, signal) ||
                source.proofRevision !== proofRevision
              ) {
                return
              }
              const result = results?.find((record) => record.path === path)
              if (result?.kind === 'absent') {
                owner.remove()
                return
              }
              if (result?.kind === 'unknown' && !result.status) {
                source.proofRetryAt = Date.now() + 60_000
              }
              const status = result?.status
              if (status) {
                source.proofRetryAt = -Infinity
              }
              if (status && !status.readError) {
                validated = true
                statusValidation.settle(true)
                source.latestEntries = status.entries
                source.partial = status.didHitLimit === true
                const evidence = mergeExplorerRepositoryEvidence(
                  source,
                  status.entries,
                  source.query,
                  source.partial
                )
                if (
                  evidence.entries !== source.entries ||
                  evidence.summaries !== source.summaries
                ) {
                  Object.assign(source, evidence)
                  owner.publish()
                }
              }
            })
          } catch {
            // Status failure does not prevent independent ignore answers from settling.
          } finally {
            if (
              !validated &&
              (proofRevision === undefined || source.proofRevision === proofRevision)
            ) {
              source.statusDirty ||= signal.aborted
              if (!signal.aborted) {
                statusValidation.settle(false)
              }
            }
          }
        }
        if (!owner.current(source, generation, signal)) {
          return
        }
        await source.ignoredQueries.run(signal)
      },
      {
        ...EXPLORER_REPOSITORY_SCHEDULER_OPTIONS,
        activityDebounceMs: 300,
        nextSafetyAt: () =>
          Math.min(
            Math.max(statusValidation.dueAt(), source.proofRetryAt),
            source.ignoredQueries.nextAt()
          )
      }
    )
  }
  return source
}

export function explorerRepositorySnapshot(
  sources: Iterable<ExplorerRepositorySource>,
  previous: readonly ExplorerRepositorySource[]
): readonly ExplorerRepositorySource[] {
  const next = [...sources].map(({ path, entries, summaries, ignored }) => ({
    path,
    entries,
    summaries,
    ignored
  }))
  return next.length === previous.length &&
    next.every((source, index) => {
      const old = previous[index]
      return (
        source.path === old.path &&
        source.entries === old.entries &&
        source.summaries === old.summaries &&
        source.ignored === old.ignored
      )
    })
    ? previous
    : next
}

export function updateExplorerRepositoryDemand(
  sources: ReadonlyMap<string, ExplorerRepositorySourceState>,
  demand: readonly string[],
  visible: boolean,
  publish: () => void,
  partition?: ExplorerRepositoryDemand
): void {
  if (sources.size === 0) {
    return
  }
  let changed = false
  const queries = (partition ?? partitionExplorerRepositoryDemand(sources, demand)).byRepository
  for (const source of sources.values()) {
    const query = [...new Set(queries.get(source.path) ?? [])].sort()
    if (JSON.stringify(query) === JSON.stringify(source.query)) {
      continue
    }
    source.query = query
    const added = source.ignoredQueries.setDemand(query)
    source.ignored = source.ignoredQueries.answers
    if (source.partial) {
      Object.assign(
        source,
        mergeExplorerRepositoryEvidence(source, source.latestEntries, query, true)
      )
    }
    changed = true
    if (visible && added) {
      source.scheduler.signal()
    }
  }
  if (changed) {
    publish()
  }
}
